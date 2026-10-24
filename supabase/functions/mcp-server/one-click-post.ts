// ---------------------------------------------------------------------------
// one-click-post: send an RFC 8058 one-click unsubscribe request, safely
// ---------------------------------------------------------------------------
//
// WHAT. A sender that publishes both
//   List-Unsubscribe: <https://...>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
// accepts a POST with the body `List-Unsubscribe=One-Click` to that URL as an
// unsubscribe. This module sends exactly that request and reports how it went.
// Deciding WHETHER a sender qualifies (DKIM coverage, alignment, not in Junk)
// is the caller's job; see list-unsubscribe.ts.
//
// WHY IT IS GUARDED. The URL comes from a mail header, which anyone who can
// send the user an email controls. Without checks it is a server-side request
// to a destination of an attacker's choosing. So, in order:
//
//   1. The URL must be https, on the default port (empty or 443), with no user
//      name or password, and of bounded length.
//   2. An IP-literal host is judged here, synchronously, with the host-guard
//      address policy (private, loopback, link-local, CGNAT, ULA, multicast,
//      metadata and every encoding of them). This runs even when a test or a
//      caller injects its own `guard`, so the literal check cannot be skipped.
//   3. The host is then passed to `guard`, by default `guardHttpsHost`, which
//      resolves the name and refuses it if ANY answer is non-public.
//   4. The POST never follows a redirect (`redirect: "manual"`). A 3xx is a
//      failure: RFC 8058 says the POST itself is the unsubscribe, and following
//      a Location would be a second, unchecked destination.
//   5. No cookies or credentials are sent (Deno's fetch has no cookie jar; the
//      headers are built here and carry nothing but the content type and a
//      plain User-Agent), the whole request is under one timeout, and at most
//      ONE_CLICK_MAX_RESPONSE_BYTES of the response are read before the stream
//      is cancelled. Nothing about the response body is returned.
//
// KNOWN LIMIT. The guard approves the host's addresses and `fetch` then
// resolves the name again, so a record repointed between the two is dialled
// unchecked. What that buys an attacker is a TLS connect to an internal :443
// that would have to present a valid certificate for the attacker's own name,
// and a fixed POST body they cannot shape; nothing from the response is
// returned beyond the status. Deno's fetch cannot be pinned to an address
// without giving up certificate validation, which is worse. The same trade is
// documented in signature-images.ts and draft-attachments.ts.
//
// LOGGING. The URL usually carries a per-recipient token that IS the
// unsubscribe credential. Never log it; log `redactUnsubscribeUrl(url)`.
// ---------------------------------------------------------------------------

import { guardHttpsHost, isAllowedAddress, parseLooseIpv4 } from "./host-guard.ts";

export type OneClickError = "invalid_url" | "blocked_host" | "redirect" | "http_error" | "timeout" | "network";

export interface OneClickResult {
  /** True only for a 2xx answer to the POST itself. */
  ok: boolean;
  /** The HTTP status, or null when no response arrived (or none was sent). */
  status: number | null;
  error?: OneClickError;
  durationMs: number;
}

export interface OneClickOptions {
  /** Whole request, guard included. Defaults to ONE_CLICK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test seam. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Resolves and judges the host; rejects to refuse it. Defaults to
   * `defaultOneClickGuard` (guardHttpsHost). IP literals are checked before
   * this runs, whatever is injected.
   */
  guard?: (host: string) => Promise<void>;
}

export const ONE_CLICK_TIMEOUT_MS = 10_000;
/** Response bytes read before the stream is cancelled. */
export const ONE_CLICK_MAX_RESPONSE_BYTES = 16 * 1024;
/** The exact body RFC 8058 section 3.1 specifies. */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
/** Plain and identifying, so a sender's logs show who asked. */
export const ONE_CLICK_USER_AGENT = "MCPEmails-Unsubscribe/1.0 (+https://mcpemails.com)";
/** Longer than any real unsubscribe link; a header that is not is not one. */
export const ONE_CLICK_MAX_URL_LENGTH = 2048;

/** Raised by the default guard. `code` is the host-guard code. */
export class OneClickHostError extends Error {
  constructor(readonly code: string) {
    super(`one-click host refused (${code})`);
    this.name = "OneClickHostError";
  }
}

/** The production guard: guardHttpsHost, thrown as OneClickHostError. */
export async function defaultOneClickGuard(host: string): Promise<void> {
  const verdict = await guardHttpsHost(host);
  if (!verdict.ok) throw new OneClickHostError(verdict.code);
}

/**
 * Scheme and host only, for logs. The path and query are where the
 * unsubscribe token lives, so they are never part of the output.
 */
export function redactUnsubscribeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return "[invalid url]";
  }
}

/** The parsed URL if it may be posted to at all (rule 1), else null. */
export function oneClickUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > ONE_CLICK_MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.port !== "" && url.port !== "443") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname.length === 0) return null;
  return url;
}

/**
 * Rule 2. The URL parser has already canonicalised IPv4 encodings
 * (`2130706433`, `0x7f.1`) to a dotted quad and bracketed any IPv6 literal, so
 * a literal is either bracketed or parses as IPv4. Names return true here and
 * are left to the guard.
 */
function literalHostAllowed(hostname: string): boolean {
  if (hostname.startsWith("[")) return isAllowedAddress(hostname.slice(1, -1));
  if (parseLooseIpv4(hostname) !== null) return isAllowedAddress(hostname);
  return true;
}

/** Read at most `limit` bytes of a body, then cancel the rest. Never throws. */
async function drainCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  let read = 0;
  try {
    while (read < limit) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value?.length ?? 0;
    }
    await reader.cancel().catch(() => {});
  } catch {
    // The status already decided the outcome; a body that breaks off (or is
    // aborted by the timeout) changes nothing.
    await reader.cancel().catch(() => {});
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or errored; nothing to do.
    }
  }
}

export async function postOneClick(url: string, opts: OneClickOptions = {}): Promise<OneClickResult> {
  const started = performance.now();
  const done = (result: Omit<OneClickResult, "durationMs">): OneClickResult => ({
    ...result,
    durationMs: Math.round(performance.now() - started),
  });

  const parsed = oneClickUrl(url);
  if (parsed === null) return done({ ok: false, status: null, error: "invalid_url" });
  if (!literalHostAllowed(parsed.hostname)) return done({ ok: false, status: null, error: "blocked_host" });

  const signal = AbortSignal.timeout(opts.timeoutMs ?? ONE_CLICK_TIMEOUT_MS);
  const guard = opts.guard ?? defaultOneClickGuard;
  try {
    await guard(parsed.hostname);
  } catch (err) {
    // A name that does not resolve is not a refusal of the destination, it is
    // a delivery failure, and the caller may retry it later.
    if (err instanceof OneClickHostError && err.code === "host_not_found") {
      return done({ ok: false, status: null, error: "network" });
    }
    return done({ ok: false, status: null, error: "blocked_host" });
  }
  if (signal.aborted) return done({ ok: false, status: null, error: "timeout" });

  const doFetch = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(parsed.href, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ONE_CLICK_USER_AGENT,
      },
      body: ONE_CLICK_BODY,
      signal,
    });
  } catch (err) {
    const name = err instanceof Error || err instanceof DOMException ? err.name : "";
    if (signal.aborted || name === "TimeoutError" || name === "AbortError") {
      return done({ ok: false, status: null, error: "timeout" });
    }
    return done({ ok: false, status: null, error: "network" });
  }

  // `opaqueredirect` is what a browser-style fetch hands back for a manual
  // redirect (status 0); Deno returns the real 3xx. Both are a refusal.
  if (resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400)) {
    await resp.body?.cancel().catch(() => {});
    return done({ ok: false, status: resp.status || null, error: "redirect" });
  }

  await drainCapped(resp.body, ONE_CLICK_MAX_RESPONSE_BYTES);
  if (resp.status >= 200 && resp.status < 300) return done({ ok: true, status: resp.status });
  return done({ ok: false, status: resp.status, error: "http_error" });
}
