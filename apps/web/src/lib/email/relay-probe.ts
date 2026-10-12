import {
  mailRelaysFromEnv,
  openMailRelayTunnel,
  MailRelayUnavailableError,
  type MailRelayConfig,
  type NamedMailRelay,
} from './mail-relay.ts';
import { validateImapCredential, type ImapCredential, type MailSecurity } from './validate-imap.ts';
import { validateSmtpCredential, type SmtpCredential } from './validate-smtp.ts';

/**
 * lib/email/relay-probe.ts — everything one refused sign-in can tell us.
 *
 * A provider that refuses the sign-in itself (see `isProviderRefusal`) leaves
 * one question open: what about the sign-in it objects to. The provider this
 * was written for issues mailboxes only with a French internet contract, so we
 * have none to test with, and the only login that can answer is a customer's.
 * A customer should be asked for that exactly once. So a single refused attempt
 * is made to answer every question we would otherwise have to come back for:
 *
 *   1. Does a FRENCH address get in?            IMAP through the relay in France
 *   2. Does a non-AWS address elsewhere get in? IMAP through the relay in Germany
 *   3. If neither: is it the login METHOD?      IMAP LOGIN instead of SASL PLAIN
 *   4. Is SENDING refused from here as well?    SMTP direct
 *   5. Does sending work from a relay?          SMTP through the relay in Germany
 *
 * Step 5 uses Germany, not France, and port 587: `smtp.orange.fr` greets the
 * French relay's address with `550 Service refused. OFR_99` before any login,
 * while it greets AWS and the German relay normally, and the German relay's
 * host blocks outbound 465.
 *
 * Each step is one login. The IMAP steps run one after another, never in
 * parallel: several sign-ins arriving at once from three countries is the shape
 * of an attack. Only the two SMTP steps overlap, for the reason given there.
 * Step 3 only runs when 1 and 2 were both refused, because a relay that got in
 * has already shown the method is fine.
 *
 * Nothing here connects an inbox, stores a credential or changes what the user
 * is told. It never throws: this runs on a path that has already failed, and a
 * broken diagnostic must not make that worse.
 */

/**
 *   - `accepted`: the login got in.
 *   - `refused`: the server answered the login with a refusal, kept in `detail`.
 *   - `blocked`: the server turned the connection away before any login, with
 *     the greeting kept in `detail`. About the address, never the credential.
 *   - `inconclusive`: the host was reached and the check died before a login
 *     was answered (timeout, TLS, protocol).
 *   - `unavailable`: the relay itself could not carry the connection.
 *   - `not_configured`: that relay is not set up in this environment.
 */
export type ProbeOutcome = 'accepted' | 'refused' | 'blocked' | 'inconclusive' | 'unavailable' | 'not_configured';

export interface ProbeStep {
  outcome: ProbeOutcome;
  /** Sanitized server rejection text, when the server gave one. */
  detail: string | null;
}

export type ProbeStepName = 'imap_fr' | 'imap_de' | 'imap_login' | 'smtp_direct' | 'smtp_de';

/** The one submission port the German relay's host lets out. */
const RELAY_SMTP_PORT = 587;

export interface RelayProbeResult {
  steps: Partial<Record<ProbeStepName, ProbeStep>>;
  /** `imap_fr=accepted imap_de=refused ...`, for reading a row at a glance. */
  summary: string;
}

/** Per IMAP step. Orange answers an IMAP login in about a second. */
export const RELAY_PROBE_STEP_TIMEOUT_MS = 6_000;

/**
 * Per SMTP step. Much longer on purpose: `smtp.orange.fr` holds a refused AUTH
 * for about eight seconds before answering (measured on 465 and on 587), so a
 * budget sized for IMAP records every refusal as a timeout.
 */
export const RELAY_PROBE_SMTP_TIMEOUT_MS = 15_000;

export interface RelayProbeInput {
  email: string;
  username?: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  /** The address the host guard approved for the direct SMTP dial. */
  smtpPinnedAddress?: string;
}

type Validation = { ok: true } | { ok: false; code: string; detail?: string };

interface RelayProbeDeps {
  relays?: NamedMailRelay[];
  validateImap?: (cred: ImapCredential) => Promise<Validation>;
  validateSmtp?: (cred: SmtpCredential) => Promise<Validation>;
  openTunnel?: typeof openMailRelayTunnel;
}

const NOT_CONFIGURED: ProbeStep = { outcome: 'not_configured', detail: null };

export async function probeProviderRefusal(input: RelayProbeInput, deps: RelayProbeDeps = {}): Promise<RelayProbeResult> {
  const relays = deps.relays ?? mailRelaysFromEnv();
  const validateImap = deps.validateImap ?? validateImapCredential;
  const validateSmtp = deps.validateSmtp ?? validateSmtpCredential;
  const openTunnel = deps.openTunnel ?? openMailRelayTunnel;
  const relay = (id: NamedMailRelay['id']) => relays.find((entry) => entry.id === id)?.config ?? null;

  /** Run one login and reduce it to a step. `config` null means a direct dial. */
  const step = async (
    config: MailRelayConfig | null,
    target: { host: string; port: number },
    run: (tunnel: (() => Promise<import('net').Socket>) | undefined) => Promise<Validation>
  ): Promise<ProbeStep> => {
    let relayFailed = false;
    const tunnel = config
      ? async () => {
          try {
            return await openTunnel(config, target.host, target.port);
          } catch (error) {
            if (error instanceof MailRelayUnavailableError) relayFailed = true;
            throw error;
          }
        }
      : undefined;
    let result: Validation;
    try {
      result = await run(tunnel);
    } catch {
      return { outcome: 'inconclusive', detail: null };
    }
    if (result.ok) return { outcome: 'accepted', detail: null };
    if (relayFailed) return { outcome: 'unavailable', detail: null };
    if (result.code === 'AUTH_FAILED') return { outcome: 'refused', detail: result.detail ?? null };
    // A greeting that was itself a refusal: no login was attempted.
    if (result.code === 'SMTP_PROTOCOL_ERROR' && result.detail) return { outcome: 'blocked', detail: result.detail };
    return { outcome: 'inconclusive', detail: null };
  };

  const imap = (config: MailRelayConfig, mechanism?: ImapCredential['mechanism']) =>
    step(config, { host: input.imapHost, port: input.imapPort }, (tunnel) =>
      validateImap({
        host: input.imapHost,
        port: input.imapPort,
        email: input.email,
        username: input.username,
        password: input.password,
        security: 'tls',
        timeoutMs: RELAY_PROBE_STEP_TIMEOUT_MS,
        tunnel,
        mechanism,
      })
    );
  const smtp = (config: MailRelayConfig | null) => {
    const port = config ? RELAY_SMTP_PORT : input.smtpPort;
    const security: MailSecurity = config ? 'starttls' : input.smtpSecurity;
    return step(config, { host: input.smtpHost, port }, (tunnel) =>
      validateSmtp({
        host: input.smtpHost,
        port,
        email: input.email,
        username: input.username,
        password: input.password,
        security,
        timeoutMs: RELAY_PROBE_SMTP_TIMEOUT_MS,
        pinnedAddress: config ? undefined : input.smtpPinnedAddress,
        tunnel,
      })
    );
  };

  const fr = relay('fr');
  const de = relay('de');
  const steps: RelayProbeResult['steps'] = {};

  steps.imap_fr = fr ? await imap(fr) : NOT_CONFIGURED;
  steps.imap_de = de ? await imap(de) : NOT_CONFIGURED;
  // Only worth a login when no relay got in, and only where it has the best
  // chance: from France if we have it, otherwise from wherever we do.
  const anyAccepted = steps.imap_fr.outcome === 'accepted' || steps.imap_de.outcome === 'accepted';
  const loginRelay = fr ?? de;
  if (!anyAccepted && loginRelay) steps.imap_login = await imap(loginRelay, 'LOGIN');
  // The two SMTP logins are the exception to one-at-a-time: the server sits on
  // a refusal for eight seconds, and the user is watching a spinner.
  const [smtpDirect, smtpDe] = await Promise.all([smtp(null), de ? smtp(de) : Promise.resolve(NOT_CONFIGURED)]);
  steps.smtp_direct = smtpDirect;
  steps.smtp_de = smtpDe;

  const summary = (Object.entries(steps) as [ProbeStepName, ProbeStep][])
    .map(([name, value]) => `${name}=${value.outcome}`)
    .join(' ');
  return { steps, summary };
}
