/**
 * relay-registry.ts — which hosts have LEARNED to need the relay, and a record
 * of every connection the relay carried.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * smtp-relay.ts relays a short, hand-kept list of hosts (Domeneshop for
 * submission, Orange for everything). Each entry on it was added after a
 * customer wrote in. A 2026-10-15 sweep of the connect logs found hosts that
 * refuse our AWS egress where nobody wrote in: Telstra's submission port timed
 * out 15 times for two workspaces, and both settled for receive-only. So the
 * hand-kept list is now the floor, not the whole answer:
 *
 *   1. A direct connection that fails in a way a different egress address can
 *      fix (see {@link isOriginRefusalText} and the callers' own checks) is
 *      tried ONCE more through the relay.
 *   2. If that works, the database decides whether to remember the host in
 *      `mail_relay_hosts` (learn_mail_relay_host, migration 20261015200000):
 *      only at a second rescue at least 5 minutes after the first, and never
 *      for a host with 5 or more direct successes in the last 7 days. Once
 *      learned, every later connection goes through the relay first, in this
 *      runtime and in the web app, without a deploy. A host that is not
 *      learned loses nothing: each failed call still gets its own retry.
 *   3. A learned entry is honoured for {@link LEARNED_RELAY_MAX_AGE_DAYS}. After
 *      that the next connection is tried directly again, and the host is
 *      re-learned if it still needs the relay. That is the re-check: a host
 *      that lifts its block drops off by itself.
 *
 * Every relayed connection is also counted in `mail_relay_stats`, which is what
 * the relay panel on /admin/growth reads.
 *
 * ── What is safe to retry ──────────────────────────────────────────────────
 *
 * Only failures where nothing was transmitted and no credential was refused on
 * its merits: a connection that never opened, a greeting that turned us away,
 * an SMTP rejection before DATA, and a login refusal whose text names where we
 * connect from rather than the password. A plain wrong password is never
 * retried: it would only add a failed sign-in against the customer's account.
 *
 * ── Storage is injected ────────────────────────────────────────────────────
 *
 * index.ts hands this module a store backed by the service-role client. With
 * no store (tests, self-hosting without the migration) nothing is learned or
 * recorded and the relay behaves exactly as the hand-kept list says.
 */

import { normalizeMailHost } from "./host-guard.ts";
import { backgroundRuntime } from "./request-pipeline.ts";

export type RelayProtocol = "imap" | "smtp";

/**
 * How a relayed connection came to be relayed.
 *   listed   — on the hand-kept list (env or the defaults in smtp-relay.ts)
 *   learned  — in `mail_relay_hosts`
 *   fallback — a direct attempt just failed and this is the one retry
 */
export type RelayRoute = "listed" | "learned" | "fallback";

/**
 *   ok           — the relay carried it and the mail host accepted the session
 *   relay_down   — the relay itself could not carry it (down, 407, timeout)
 *   host_refused — the tunnel worked and the mail host still said no
 */
export type RelayOutcome = "ok" | "relay_down" | "host_refused";

export interface RelayUseEvent {
  protocol: RelayProtocol;
  host: string;
  route: RelayRoute;
  outcome: RelayOutcome;
  ms: number;
  /** Short, credential-free description of a failure. Never message content. */
  detail?: string | null;
}

export interface RelayRegistryStore {
  loadLearned(maxAgeDays: number): Promise<Array<{ host: string; protocol: RelayProtocol }>>;
  /** True when the host is now relayed; false when the store refused (see the SQL gate). */
  learn(host: string, protocol: RelayProtocol, reason: string): Promise<boolean>;
  record(event: RelayUseEvent): Promise<void>;
}

/** See the header, point 3. */
export const LEARNED_RELAY_MAX_AGE_DAYS = 30;

/** How long the learned list is trusted before it is read again. */
export const LEARNED_RELAY_REFRESH_MS = 5 * 60_000;

/** Ceiling on the read that refreshes the list. A slow database must not slow mail. */
export const LEARNED_RELAY_LOAD_TIMEOUT_MS = 1_500;

/**
 * How long a host whose relay retry also failed is left alone.
 *
 * Without this a host that is simply down would cost a direct attempt AND a
 * relay attempt on every call for as long as the outage lasts.
 */
export const RELAY_FALLBACK_COOLDOWN_MS = 10 * 60_000;

/** Longest `detail` kept. Enough for an SMTP reply line. */
const MAX_DETAIL_CHARS = 200;

let store: RelayRegistryStore | null = null;
const learned: Record<RelayProtocol, Set<string>> = { imap: new Set(), smtp: new Set() };
let loadedAt = 0;
let loading: Promise<void> | null = null;
const fallbackFailedUntil = new Map<string, number>();

/** Called once by index.ts. Null switches learning and recording off. */
export function configureRelayRegistry(next: RelayRegistryStore | null): void {
  store = next;
  loadedAt = 0;
  loading = null;
}

/** Test-only: forget everything this isolate has learned or counted. */
export function resetRelayRegistryForTests(): void {
  store = null;
  learned.imap.clear();
  learned.smtp.clear();
  loadedAt = 0;
  loading = null;
  fallbackFailedUntil.clear();
}

/**
 * Make sure the learned list is no older than {@link LEARNED_RELAY_REFRESH_MS}.
 *
 * Awaited before a connection is opened, so a host learned by the web app is
 * relayed here within minutes. Never throws, and never waits longer than
 * {@link LEARNED_RELAY_LOAD_TIMEOUT_MS}: on any failure the previous list is
 * kept and the next refresh is a full interval away, so a database outage
 * costs one bounded wait per isolate rather than one per connection.
 */
export async function refreshLearnedRelayHosts(now: number = Date.now()): Promise<void> {
  if (!store) return;
  if (now - loadedAt < LEARNED_RELAY_REFRESH_MS) return;
  if (!loading) {
    const source = store;
    loading = (async () => {
      try {
        const rows = await withTimeout(source.loadLearned(LEARNED_RELAY_MAX_AGE_DAYS), LEARNED_RELAY_LOAD_TIMEOUT_MS);
        learned.imap.clear();
        learned.smtp.clear();
        for (const row of rows) {
          const host = normalizeMailHost(row.host);
          if (host && (row.protocol === "imap" || row.protocol === "smtp")) learned[row.protocol].add(host);
        }
      } catch (err) {
        console.warn("[mcp-server] relay_registry: could not load learned hosts", { error: errorText(err) });
      } finally {
        loadedAt = Date.now();
        loading = null;
      }
    })();
  }
  await loading;
}

/** True when `host` has learned to need the relay for `protocol`. Exact host match. */
export function isLearnedRelayHost(host: string, protocol: RelayProtocol): boolean {
  const target = normalizeMailHost(host);
  return target.length > 0 && learned[protocol].has(target);
}

/**
 * Report one relay rescue of `host`, which may make the store learn it.
 *
 * Takes effect in this isolate only once the store says the host is learned,
 * and everywhere else once their lists refresh. Usually it says no: one rescue
 * only makes a candidate, and a host that works directly is never learned
 * (learn_mail_relay_host, migration 20261015200000). Fire and forget.
 */
export function learnRelayHost(host: string, protocol: RelayProtocol, reason: string): void {
  const target = normalizeMailHost(host);
  if (!target) return;
  const source = store;
  if (!source) return;
  inBackground("learn", async () => {
    const accepted = await source.learn(target, protocol, clip(reason) ?? "");
    if (accepted) learned[protocol].add(target);
    console.log("[mcp-server] relay_registry: learn", { host: target, protocol, accepted, reason: clip(reason) });
  });
}

/** Count one relayed connection. Fire and forget; never fails the caller. */
export function recordRelayUse(event: RelayUseEvent): void {
  const source = store;
  if (!source) return;
  const host = normalizeMailHost(event.host);
  if (!host) return;
  inBackground("record", () =>
    source.record({ ...event, host, ms: Math.max(0, Math.round(event.ms)), detail: clip(event.detail) })
  );
}

/** True while a host's last relay retry failed recently. See the cooldown. */
export function relayFallbackCoolingDown(host: string, protocol: RelayProtocol, now: number = Date.now()): boolean {
  const until = fallbackFailedUntil.get(`${protocol}:${normalizeMailHost(host)}`);
  return until !== undefined && now < until;
}

export function noteRelayFallbackFailed(host: string, protocol: RelayProtocol, now: number = Date.now()): void {
  fallbackFailedUntil.set(`${protocol}:${normalizeMailHost(host)}`, now + RELAY_FALLBACK_COOLDOWN_MS);
}

/**
 * True when a refusal's own words blame where we connect from.
 *
 * The cases this was written against, all measured:
 *   - Orange IMAP: `NO [ALERT] Authentication failed.` for a correct password
 *     from AWS, accepted through the relay (2026-10-12).
 *   - Domeneshop SMTP: `550 [ACR04] Amazon AWS IP <addr> may not use this server`.
 *   - Telenor SMTP: `535 5.7.0 Authentication disabled due to threshold limitation`
 *     right after the same password passed IMAP (2026-10-01).
 *
 * Deliberately NOT matched: the ordinary wrong-password answers
 * (`[AUTHENTICATIONFAILED] Authentication failed`, `535 5.7.8`, `Invalid
 * credentials`). A bare "blocked" or "blacklist" is not matched either, because
 * that wording turns up in recipient rejections ("the domain may be
 * blacklisted") that no egress change fixes.
 */
export function isOriginRefusalText(text: string | null | undefined): boolean {
  const value = String(text ?? "");
  if (!value) return false;
  if (/\[ALERT\]/i.test(value) && !/app(lication)?[- ]specific password|enable imap|imap is disabled/i.test(value)) {
    return true;
  }
  return ORIGIN_REFUSAL_PATTERN.test(value);
}

const ORIGIN_REFUSAL_PATTERN = new RegExp(
  [
    String.raw`\b(amazon|aws|ec2|azure|google cloud|cloud (server|service|provider)s?)\b`,
    String.raw`\b(hosting|cloud|rdp) (service )?provider`,
    String.raw`\bdata ?cent(er|re)\b`,
    String.raw`\b(server|client|your|sender|source|connecting) ip\b`,
    String.raw`\bip (address )?\S* ?(is |was )?(not allowed|not permitted|blocked|listed|refused|denied|may not)`,
    String.raw`\bmay not use this server\b`,
    String.raw`\bthreshold limitation\b`,
    String.raw`\bnot allowed from\b`,
    String.raw`\bfrom (your|this) (location|country|network|region)\b`,
    String.raw`\b(spamhaus|pbl|dnsbl|rbl)\b`,
    String.raw`\bACR0\d\b`,
    String.raw`\bOFR\d*_\d+\b`,
    String.raw`\bservice refused\b`,
  ].join("|"),
  "i",
);

/** A short, single-line reason for the log and the learned row. */
export function relayReason(err: unknown): string {
  return clip(errorText(err)) ?? "unknown";
}

function inBackground(name: string, run: () => Promise<unknown>): void {
  const task = run().catch((err) => {
    console.warn(`[mcp-server] relay_registry: ${name} failed`, { error: errorText(err) });
  });
  const runtime = backgroundRuntime();
  if (runtime?.waitUntil) {
    try {
      runtime.waitUntil(task);
    } catch {
      // The task is already running; losing the keep-alive only risks the row.
    }
  }
}

function clip(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const single = String(text).replace(/\s+/g, " ").trim();
  return single.length > MAX_DETAIL_CHARS ? `${single.slice(0, MAX_DETAIL_CHARS - 1)}…` : single;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
