import {
  mailRelayConfigFromEnv,
  openMailRelayTunnel,
  MailRelayUnavailableError,
  type MailRelayConfig,
} from './mail-relay.ts';
import { validateImapCredential, type ImapValidationResult } from './validate-imap.ts';

/**
 * What a login got when it was repeated from the relay's address.
 *
 *   - `accepted`: the same credential that was refused directly logged in. The
 *     provider objects to where this app connects from.
 *   - `refused_same`: the relay got the provider's own refusal too
 *     (`[ALERT]`). A different address did not help, so the cause is something
 *     else about the sign-in or the mailbox.
 *   - `refused_other`: the relay was refused with a different answer, recorded
 *     in `detail`.
 *   - `inconclusive`: the relay reached the host and the check failed before a
 *     login was answered (timeout, TLS).
 *   - `unavailable`: the relay itself could not carry the connection.
 *   - `not_configured`: no relay is set up in this environment.
 */
export type RelayProbeOutcome =
  | 'accepted'
  | 'refused_same'
  | 'refused_other'
  | 'inconclusive'
  | 'unavailable'
  | 'not_configured';

export interface RelayProbeResult {
  outcome: RelayProbeOutcome;
  /** Sanitized server rejection text from the relay attempt, when there was one. */
  detail: string | null;
}

/** The whole relay attempt, tunnel included. The user is waiting on it. */
export const RELAY_PROBE_TIMEOUT_MS = 8_000;

const SAME_REFUSAL = /^NO \[ALERT\]/i;

export interface RelayProbeInput {
  host: string;
  port: number;
  email: string;
  username?: string;
  password: string;
}

interface RelayProbeDeps {
  config?: MailRelayConfig | null;
  validate?: typeof validateImapCredential;
  openTunnel?: typeof openMailRelayTunnel;
}

/**
 * Repeat one implicit-TLS IMAP login through the relay and say what happened.
 * Never throws: this runs on a path that has already failed, and a broken
 * diagnostic must not change what the user is told.
 */
export async function probeImapThroughRelay(input: RelayProbeInput, deps: RelayProbeDeps = {}): Promise<RelayProbeResult> {
  const config = deps.config === undefined ? mailRelayConfigFromEnv() : deps.config;
  if (!config) return { outcome: 'not_configured', detail: null };
  const validate = deps.validate ?? validateImapCredential;
  const openTunnel = deps.openTunnel ?? openMailRelayTunnel;

  let relayFailed = false;
  let result: ImapValidationResult;
  try {
    result = await validate({
      host: input.host,
      port: input.port,
      email: input.email,
      username: input.username,
      password: input.password,
      security: 'tls',
      timeoutMs: RELAY_PROBE_TIMEOUT_MS,
      tunnel: async () => {
        try {
          return await openTunnel(config, input.host, input.port);
        } catch (error) {
          if (error instanceof MailRelayUnavailableError) relayFailed = true;
          throw error;
        }
      },
    });
  } catch {
    return { outcome: 'inconclusive', detail: null };
  }

  if (result.ok) return { outcome: 'accepted', detail: null };
  if (relayFailed) return { outcome: 'unavailable', detail: null };
  if (result.code !== 'AUTH_FAILED') return { outcome: 'inconclusive', detail: null };
  const detail = result.detail ?? null;
  return { outcome: detail && SAME_REFUSAL.test(detail) ? 'refused_same' : 'refused_other', detail };
}
