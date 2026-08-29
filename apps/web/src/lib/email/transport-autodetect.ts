/**
 * Transport autodetection for the generic IMAP/SMTP connector.
 *
 * The user should never have to know what STARTTLS is. In production they do:
 * connecting a generic mailbox succeeds a quarter of the time, and the recorded
 * failures are people guessing at transport settings by hand (one workspace made
 * twelve consecutive attempts against the same host, alternating 993/implicit-TLS
 * and 143/STARTTLS). Every one of those alternations is something a machine can
 * do in a few seconds without asking.
 *
 * So a failed attempt that never established a usable session is retried on the
 * other standard transport instead of being reported. The whole value of this
 * module is in deciding WHICH failures earn a retry, and it is deliberately a
 * pure decision layer: the caller supplies the function that actually opens a
 * socket, so the policy is unit-testable without a mail server.
 *
 * ── Why the retry set is narrow ─────────────────────────────────────────────
 *
 * A rejected password must NOT be retried. If the server completed a greeting,
 * accepted our AUTHENTICATE and answered NO, it speaks the protocol perfectly
 * well on this port and the transport is not the problem. Re-sending the same
 * credential over two more transports would triple the failed-login count that
 * providers use for rate limiting and account lockout, and would still end in
 * the same error. The distinction the caller must preserve is exactly:
 *
 *   "could not establish a usable session"  → try another transport
 *   "session established, credential refused" → stop, report a credential error
 */

import type { SmtpSecurity as MailSecurity } from '../email-providers/imap-presets';

export type { MailSecurity };

/** One transport to try: a port and the security mode that goes with it. */
export interface TransportCandidate {
  port: number;
  security: MailSecurity;
  /**
   * True for the combination the caller actually asked for (typed by the user,
   * or resolved from a host preset). Exactly one candidate in a plan carries
   * it, and it is always first: a user who deliberately set an unusual port
   * gets that port tried before anything we guess.
   */
  requested: boolean;
}

/**
 * Failure codes that mean "we never got a usable session on this port".
 *
 * CONNECTION_REFUSED and CONNECTION_TIMEOUT are the port being wrong.
 * TLS_HANDSHAKE_FAILED is implicit TLS against a plaintext listener, or a
 * STARTTLS the server does not offer. A protocol error is the mirror case,
 * plaintext parsing of a TLS record, which arrives as an unparseable greeting.
 *
 * Absent, on purpose: AUTH_FAILED (the credential was refused by a server that
 * spoke to us), AUTH_MECHANISM_UNSUPPORTED (the server reached the AUTH stage
 * and refused the mechanism, which no port change fixes) and HOST_NOT_FOUND
 * (DNS has no answer, so every port fails identically and retrying only wastes
 * the request's time budget).
 */
export const TRANSPORT_RETRY_CODES: ReadonlySet<string> = new Set([
  'CONNECTION_REFUSED',
  'CONNECTION_TIMEOUT',
  'TLS_HANDSHAKE_FAILED',
  'IMAP_PROTOCOL_ERROR',
  'SMTP_PROTOCOL_ERROR',
]);

/** True when a failure code is worth retrying on a different transport. */
export function isTransportFailure(code: string | undefined | null): boolean {
  return typeof code === 'string' && TRANSPORT_RETRY_CODES.has(code.toUpperCase());
}

/**
 * The standard transports, in the order they are worth trying.
 *
 * IMAP has exactly two in the wild. SMTP has three, and 25 is last because on
 * most networks it is either filtered outbound or reserved for server-to-server
 * relay that will not accept a submission login; it is here for the small hosts
 * that still only offer it.
 */
const STANDARD_TRANSPORTS: Record<'imap' | 'smtp', readonly { port: number; security: MailSecurity }[]> = {
  imap: [
    { port: 993, security: 'tls' },
    { port: 143, security: 'starttls' },
  ],
  smtp: [
    { port: 465, security: 'tls' },
    { port: 587, security: 'starttls' },
    { port: 25, security: 'starttls' },
  ],
};

/** Hard ceiling on attempts per protocol, regardless of how many candidates exist. */
export const MAX_TRANSPORT_ATTEMPTS = 3;

/**
 * Build the ordered list of transports to try for one protocol.
 *
 * The requested combination is always first and always present, even when it is
 * not one of the standard ones: a host that serves IMAP on 1993 exists, and
 * silently ignoring what the user typed in favour of a guess would be worse
 * than the bug this module fixes. The standard alternatives follow, deduplicated
 * against it, capped at MAX_TRANSPORT_ATTEMPTS.
 */
export function transportPlan(
  protocol: 'imap' | 'smtp',
  requested: { port: number; security: MailSecurity }
): TransportCandidate[] {
  const plan: TransportCandidate[] = [
    { port: requested.port, security: requested.security, requested: true },
  ];
  for (const candidate of STANDARD_TRANSPORTS[protocol]) {
    if (plan.length >= MAX_TRANSPORT_ATTEMPTS) break;
    const duplicate = plan.some((p) => p.port === candidate.port && p.security === candidate.security);
    if (!duplicate) plan.push({ ...candidate, requested: false });
  }
  return plan;
}

/**
 * Wall-clock budget for one protocol's whole detection run, and the per-attempt
 * timeouts inside it.
 *
 * The route has no maxDuration override, so it runs on the platform default and
 * has to stay comfortably inside it; IMAP and SMTP are detected in sequence, so
 * the request's worst case is roughly twice PROTOCOL_BUDGET_MS plus the database
 * round trips. The budget is checked BEFORE each attempt rather than racing it,
 * so an attempt already in flight always finishes on its own timeout.
 *
 * The first attempt keeps the original 10s: it is the combination most likely to
 * be right, and shortening it would start failing slow-but-working servers that
 * connect today. Retries get less, because a retry only happens after something
 * already failed and the user is now waiting on a guess.
 */
export const FIRST_ATTEMPT_TIMEOUT_MS = 10_000;
export const RETRY_ATTEMPT_TIMEOUT_MS = 6_000;
export const PROTOCOL_BUDGET_MS = 20_000;

/** Per-attempt socket timeout: generous for the requested combination, tight for guesses. */
export function attemptTimeoutMs(attemptIndex: number): number {
  return attemptIndex === 0 ? FIRST_ATTEMPT_TIMEOUT_MS : RETRY_ATTEMPT_TIMEOUT_MS;
}

/**
 * Should another candidate be tried?
 *
 * Everything that stops the loop is here so the policy reads in one place: a
 * success, a failure that is about the credential rather than the transport, no
 * candidates left, the attempt ceiling, or not enough budget left to run a
 * retry to completion. That last check is what keeps a doomed detection run
 * from starting a 6s attempt with 2s of budget left and blowing the request's
 * deadline anyway.
 */
export function shouldTryNextTransport(state: {
  code: string | undefined | null;
  attemptsMade: number;
  candidatesRemaining: number;
  elapsedMs: number;
  budgetMs?: number;
}): boolean {
  if (!isTransportFailure(state.code)) return false;
  if (state.candidatesRemaining <= 0) return false;
  if (state.attemptsMade >= MAX_TRANSPORT_ATTEMPTS) return false;
  const budget = state.budgetMs ?? PROTOCOL_BUDGET_MS;
  return state.elapsedMs + attemptTimeoutMs(state.attemptsMade) <= budget;
}

export interface TransportAttemptOutcome<R> {
  /** The last result produced, successful or not. */
  result: R;
  /** The transport that produced it, which is what gets persisted on success. */
  candidate: TransportCandidate;
  /** How many transports were tried, including the first. */
  attempts: number;
  /** True when the winning transport is not the one the caller asked for. */
  adjusted: boolean;
}

/**
 * Run a detection plan: try candidates in order until one establishes a usable
 * session, the failure stops being about the transport, or the budget runs out.
 *
 * `attempt` is injected so this stays testable without a network, and `now` so
 * the budget logic can be tested without waiting 20 seconds.
 */
export async function detectTransport<R extends { ok: boolean; code?: string }>(
  candidates: readonly TransportCandidate[],
  attempt: (candidate: TransportCandidate, timeoutMs: number) => Promise<R>,
  options: { budgetMs?: number; now?: () => number } = {}
): Promise<TransportAttemptOutcome<R>> {
  if (candidates.length === 0) throw new Error('A transport plan needs at least one candidate.');
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? PROTOCOL_BUDGET_MS;
  const started = now();

  let index = 0;
  let result = await attempt(candidates[0], attemptTimeoutMs(0));

  while (
    !result.ok &&
    shouldTryNextTransport({
      code: result.code,
      attemptsMade: index + 1,
      candidatesRemaining: candidates.length - index - 1,
      elapsedMs: now() - started,
      budgetMs,
    })
  ) {
    index += 1;
    result = await attempt(candidates[index], attemptTimeoutMs(index));
  }

  return {
    result,
    candidate: candidates[index],
    attempts: index + 1,
    adjusted: result.ok && !candidates[index].requested,
  };
}
