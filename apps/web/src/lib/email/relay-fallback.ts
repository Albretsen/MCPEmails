/**
 * lib/email/relay-fallback.ts — when a direct connection fails, try the relay.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Some mail hosts refuse connections from this app's own servers (an AWS
 * address) and accept the same credential from anywhere else. Until now the
 * relay (mail-relay.ts) carried only a hand-kept list of them, each added after
 * a customer wrote in. A 2026-10-15 sweep of the connect logs found more that
 * nobody reported: Telstra's submission port timed out 15 times for two
 * workspaces, and both settled for a receive-only mailbox.
 *
 * So the connect form now does what an operator would: when the direct attempt
 * fails in a way a different egress address can fix, it tries once more
 * through the relay. When that works the mailbox is connected, and the rescue
 * is reported to the database, which learns the host into `mail_relay_hosts`
 * at a second rescue 5+ minutes after the first and never while it has 5+
 * direct successes in a week (migration 20261015200000). A learned host is
 * read and sent through the relay by the edge function too (supabase/functions/mcp-server/relay-registry.ts is the other
 * half, and the two copies of {@link isOriginRefusalText} must agree).
 *
 * ── What earns a relay retry ───────────────────────────────────────────────
 *
 * Only failures where no credential was judged on its merits:
 *
 *   - CONNECTION_TIMEOUT and CONNECTION_REFUSED, at any phase: the server never
 *     answered, or went quiet, or a firewall turned us away.
 *   - A greeting that turned us away (Orange's `550 Service refused. OFR_99`).
 *   - A login refusal that names where we connect from, not the password
 *     (`provider_refused_signin`, or text {@link isOriginRefusalText} matches,
 *     such as Telenor's `threshold limitation`).
 *
 * Never: a plain wrong password (it would only add a failed sign-in against the
 * customer's account), a TLS failure (in practice an expired or mismatched
 * certificate, which the tunnel reaches unchanged), or a name that does not
 * resolve.
 */

import { isIP } from 'net';
import type * as net from 'net';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import {
  isRelayOnlyMailHost,
  MailRelayTargetRefusedError,
  MailRelayUnavailableError,
  openMailRelayTunnel,
  type MailRelayConfig,
} from './mail-relay.ts';
import {
  detectTransport,
  transportPlan,
  type MailSecurity,
  type TransportAttemptOutcome,
  type TransportCandidate,
} from './transport-autodetect.ts';

export type RelayProtocol = 'imap' | 'smtp';
export type RelayRoute = 'listed' | 'learned' | 'fallback';
export type RelayOutcome = 'ok' | 'relay_down' | 'host_refused';

/** A learned host is honoured this long; mirrors LEARNED_RELAY_MAX_AGE_DAYS. */
export const LEARNED_RELAY_MAX_AGE_DAYS = 30;

/** How long this process trusts its copy of the learned list. */
const LEARNED_RELAY_REFRESH_MS = 60_000;

/**
 * Ceiling on each registry call (list read, learn, count). Mirrors
 * LEARNED_RELAY_LOAD_TIMEOUT_MS on the edge. The connect form's two protocols
 * can already spend about 75 seconds of a 90-second route on mail servers, so
 * a slow database must not be allowed to take the rest.
 */
export const RELAY_REGISTRY_TIMEOUT_MS = 1_500;

/** `promise`, or a rejection after `ms`. The losing promise is left to settle on its own. */
async function bounded<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The transports the relay can carry, per protocol.
 *
 * IMAP: implicit TLS on 993 only, because the tunnel option on the validator
 * is implicit-TLS only. SMTP: 587 with STARTTLS only, because the relay's own
 * host blocks outbound 465 (docs/smtp-relay.md).
 */
export const RELAYED_TRANSPORTS = {
  imap: { port: 993, security: 'tls' },
  smtp: { port: 587, security: 'starttls' },
} as const;

/** The shape of a failed validation, as validate-imap.ts / validate-smtp.ts return it. */
export interface DirectFailure {
  code?: string;
  phase?: string;
  detail?: string | null;
}

/**
 * Should a connection that failed directly be tried once through the relay?
 * `authReason` is explainAuthFailure's classification, when there is one.
 */
export function shouldTryRelayAfter(failure: DirectFailure, authReason?: string | null): boolean {
  const code = String(failure.code ?? '').toUpperCase();
  if (code === 'CONNECTION_TIMEOUT' || code === 'CONNECTION_REFUSED') return true;
  if ((code === 'SMTP_PROTOCOL_ERROR' || code === 'IMAP_PROTOCOL_ERROR') && failure.phase === 'greeting') {
    return true;
  }
  if (code === 'AUTH_FAILED') {
    return authReason === 'provider_refused_signin' || isOriginRefusalText(failure.detail);
  }
  return false;
}

/**
 * True when a refusal's own words blame where we connect from.
 *
 * A COPY of isOriginRefusalText in supabase/functions/mcp-server/relay-registry.ts,
 * which carries the measured cases behind each pattern. Change one, change both.
 */
export function isOriginRefusalText(text: string | null | undefined): boolean {
  const value = String(text ?? '');
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
  ].join('|'),
  'i'
);

// ---------------------------------------------------------------------------
// The registry: which hosts learned to need the relay, and what it carried.
// Every call is best-effort. The migration may be unapplied, the database may
// be slow; none of that may fail or delay a connection beyond a short wait.
// ---------------------------------------------------------------------------

type AnyClient = SupabaseClient<Database>;

let learned: Record<RelayProtocol, Set<string>> = { imap: new Set(), smtp: new Set() };
let learnedAt = 0;

function normalizeHost(host: string | null | undefined): string {
  return String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** Test-only: forget the cached list. */
export function resetRelayFallbackCacheForTests(): void {
  learned = { imap: new Set(), smtp: new Set() };
  learnedAt = 0;
}

/** Refresh the learned list if it is older than a minute. Never throws. */
export async function refreshLearnedRelayHosts(db: AnyClient, now: number = Date.now()): Promise<void> {
  if (now - learnedAt < LEARNED_RELAY_REFRESH_MS) return;
  learnedAt = now;
  try {
    const since = new Date(now - LEARNED_RELAY_MAX_AGE_DAYS * 86_400_000).toISOString();
    const { data, error } = await bounded(
      db
        .from('mail_relay_hosts')
        .select('host, protocol')
        .or(`source.eq.manual,last_learned_at.gt.${since}`),
      RELAY_REGISTRY_TIMEOUT_MS,
      'learned-host read'
    );
    if (error) throw new Error(error.message);
    const next: Record<RelayProtocol, Set<string>> = { imap: new Set(), smtp: new Set() };
    for (const row of (data ?? []) as Array<{ host: string; protocol: string }>) {
      if (row.protocol === 'imap' || row.protocol === 'smtp') next[row.protocol].add(normalizeHost(row.host));
    }
    learned = next;
  } catch (err) {
    console.warn('[relay] could not load learned hosts:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Why `host` goes through the relay for `protocol`, or null when it is dialled
 * directly. "listed" is the hand-kept relay-only list in mail-relay.ts;
 * "learned" is the registry. Call {@link refreshLearnedRelayHosts} first.
 */
export function relayRouteForHost(host: string, protocol: RelayProtocol): Exclude<RelayRoute, 'fallback'> | null {
  if (isRelayOnlyMailHost(host)) return 'listed';
  return learned[protocol].has(normalizeHost(host)) ? 'learned' : null;
}

/**
 * Report one relay rescue of `host`. Resolves true only when the database
 * learned the host: one rescue makes a candidate, and a host with 5+ direct
 * successes in a week is never learned (migration 20261015200000).
 */
export async function learnRelayHost(
  db: AnyClient,
  host: string,
  protocol: RelayProtocol,
  reason: string
): Promise<boolean> {
  const target = normalizeHost(host);
  try {
    const { data, error } = await bounded(
      db.rpc('learn_mail_relay_host', {
        p_host: target,
        p_protocol: protocol,
        p_reason: reason.slice(0, 300),
        p_runtime: 'web',
      }),
      RELAY_REGISTRY_TIMEOUT_MS,
      'learn'
    );
    if (error) throw new Error(error.message);
    const accepted = data === true;
    if (accepted) learned[protocol].add(target);
    return accepted;
  } catch (err) {
    console.warn('[relay] could not learn host:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Count one relayed connection. Never throws. */
export async function recordRelayUse(
  db: AnyClient,
  event: { protocol: RelayProtocol; host: string; route: RelayRoute; outcome: RelayOutcome; ms: number; detail?: string | null }
): Promise<void> {
  try {
    const { error } = await bounded(
      db.rpc('record_mail_relay_use', {
        p_runtime: 'web',
        p_protocol: event.protocol,
        p_host: normalizeHost(event.host),
        p_route: event.route,
        p_outcome: event.outcome,
        p_ms: Math.max(0, Math.round(event.ms)),
        p_detail: event.detail ? String(event.detail).replace(/\s+/g, ' ').slice(0, 200) : undefined,
      }),
      RELAY_REGISTRY_TIMEOUT_MS,
      'count'
    );
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn('[relay] could not record use:', err instanceof Error ? err.message : String(err));
  }
}

/** A short, credential-free reason for a direct failure. */
export function describeDirectFailure(failure: DirectFailure): string {
  return [failure.code, failure.phase, failure.detail].filter(Boolean).join(' ').slice(0, 300);
}

// ---------------------------------------------------------------------------
// The connect-form flow: relay first for hosts that need it, otherwise direct
// with one relay retry on a failure that earns it.
// ---------------------------------------------------------------------------

export interface RelayDetection<R> {
  detection: TransportAttemptOutcome<R>;
  /** How the winning (or reported) attempt was reached; null for a direct dial. */
  route: RelayRoute | null;
  /**
   * True when a relayed attempt also reached no usable answer from the host
   * (the relay itself was up). The connect panel uses it to say plainly that
   * the mail server does not accept connections from our servers. Never true
   * for a relay that was down, or when the relay was never tried.
   */
  relayAlsoFailed?: boolean;
}

/**
 * Validate one protocol of a connection the way the connect form must:
 *
 *   1. A host on the relay-only list, or one the registry learned, is checked
 *      through the relay on the one transport it carries. A learned host whose
 *      relay is down falls back to the direct plan, exactly as before it was
 *      learned; a relay-only host does not (its direct dial is known refused).
 *   2. Every other host gets the ordinary direct detection run.
 *   3. If that fails with a failure that earns it ({@link shouldTryRelayAfter}),
 *      one more attempt goes through the relay. If it works the host is learned.
 *      If it does not, the direct failure is what the user sees, unless the
 *      relayed attempt reached the server and it refused the password, which is
 *      the truer answer.
 *
 * Every relayed attempt is counted in mail_relay_stats. `db` null switches
 * learning and counting off; `relay` null switches the whole relay off.
 */
export async function detectWithRelay<R extends DirectFailure & { ok: boolean }>(opts: {
  protocol: RelayProtocol;
  host: string;
  requested: { port: number; security: MailSecurity };
  relay: MailRelayConfig | null;
  db: AnyClient | null;
  authReasonOf: (result: NoInfer<R>) => string | null;
  attempt: (
    candidate: TransportCandidate,
    timeoutMs: number,
    tunnel: (() => Promise<net.Socket>) | undefined
  ) => Promise<R>;
  openTunnel?: typeof openMailRelayTunnel;
}): Promise<RelayDetection<R>> {
  const { protocol, host, requested, relay, db } = opts;
  const openTunnel = opts.openTunnel ?? openMailRelayTunnel;

  const viaRelay = async (config: MailRelayConfig, route: RelayRoute) => {
    const transport = RELAYED_TRANSPORTS[protocol];
    let relayDown: string | null = null;
    const startedMs = Date.now();
    const detection = await detectTransport<R>(
      [{ ...transport, requested: requested.port === transport.port && requested.security === transport.security }],
      (candidate, timeoutMs) =>
        opts.attempt(candidate, timeoutMs, async () => {
          try {
            return await openTunnel(config, host, candidate.port);
          } catch (err) {
            // A relay that refused this one target is up; see MailRelayTargetRefusedError.
            if (err instanceof MailRelayUnavailableError && !(err instanceof MailRelayTargetRefusedError)) {
              relayDown = err.message;
            }
            throw err;
          }
        })
    );
    const outcome: RelayOutcome = detection.result.ok ? 'ok' : relayDown !== null ? 'relay_down' : 'host_refused';
    if (db) {
      await recordRelayUse(db, {
        protocol,
        host,
        route,
        outcome,
        ms: Date.now() - startedMs,
        detail: outcome === 'ok' ? null : relayDown ?? describeDirectFailure(detection.result),
      });
    }
    return { detection, relayDown: relayDown !== null };
  };

  const knownRoute = relay ? relayRouteForHost(host, protocol) : null;
  if (relay && knownRoute) {
    const relayed = await viaRelay(relay, knownRoute);
    if (!relayed.relayDown || knownRoute === 'listed') {
      const failedThere =
        !relayed.relayDown &&
        !relayed.detection.result.ok &&
        String(relayed.detection.result.code).toUpperCase() !== 'AUTH_FAILED';
      return { detection: relayed.detection, route: knownRoute, ...(failedThere ? { relayAlsoFailed: true } : {}) };
    }
  }

  const direct = await detectTransport<R>(transportPlan(protocol, requested), (candidate, timeoutMs) =>
    opts.attempt(candidate, timeoutMs, undefined)
  );
  if (direct.result.ok || knownRoute || !relay) return { detection: direct, route: null };
  // The relay's filter refuses IP literals, so the retry could only fail.
  if (isIP(normalizeHost(host).replace(/^\[|\]$/g, '')) !== 0) return { detection: direct, route: null };
  if (!shouldTryRelayAfter(direct.result, opts.authReasonOf(direct.result))) return { detection: direct, route: null };

  const retried = await viaRelay(relay, 'fallback');
  if (retried.detection.result.ok) {
    if (db) await learnRelayHost(db, host, protocol, describeDirectFailure(direct.result));
    return { detection: retried.detection, route: 'fallback' };
  }
  if (!retried.relayDown && String(retried.detection.result.code).toUpperCase() === 'AUTH_FAILED') {
    return { detection: retried.detection, route: 'fallback' };
  }
  return { detection: direct, route: null, ...(retried.relayDown ? {} : { relayAlsoFailed: true }) };
}
