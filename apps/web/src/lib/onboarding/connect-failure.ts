/**
 * A failed connect, as the onboarding inbox step explains it (plan A5).
 *
 * The decision is the dashboard's: the connect routes classify a rejected
 * login (email/auth-failure.ts, seven reasons) and `connectFix`
 * (email/auth-failure-help.ts) picks the provider fix and its links. This
 * module only maps that answer onto the onboarding namespace's keys
 * (steps.inbox.fail.*), because /onboarding does not ship the dashboard's
 * copy. Pure and client-safe. The password is never an input.
 */
import { connectFix } from '../email/auth-failure-help.ts';
import type { InboxKind } from './inbox-detect.ts';

export const FAILURE_REASONS = [
  'imap_disabled', 'app_password_required', 'account_password_used', 'app_password_length',
  'provider_refused_signin', 'login_username_required', 'password_rejected',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export type FailureMessage =
  | `reason.${FailureReason}`
  | 'network' | 'limit' | 'sessionExpired' | 'notAllowed' | 'alreadyConnected' | 'useMicrosoft'
  | 'smtpRejected' | 'blocked' | 'hostNotFound' | 'unreachable' | 'tls' | 'hostRefused'
  | 'saveFailed' | 'generic';

export type FailureLinkKind = 'twoStep' | 'appPasswords' | 'imapSetting' | 'providerHelp' | 'adminGuide';

export interface FailureLink {
  id: string;
  kind: FailureLinkKind;
  url: string;
  provider: string;
}

export interface ConnectFailure {
  /** The route's error code (or 'network'), for the support ticket. */
  code: string;
  reason: FailureReason | null;
  phase: string | null;
  message: FailureMessage;
  /** Provider name for the message ("Google", "Yahoo"). */
  provider: string;
  links: FailureLink[];
  /** The password is the thing to replace: clear that field only. */
  passwordProblem: boolean;
  offerReadOnly: boolean;
  offerMicrosoft: boolean;
}

export interface ConnectResult {
  network?: boolean;
  ok?: boolean;
  status?: number;
  data?: Record<string, unknown> | null;
}

/** Same fallback as the dashboard modal's failureCode(): the status decides when no code came back. */
export function failureCodeOf(status: number | undefined, data: Record<string, unknown> | null | undefined): string {
  const code = typeof data?.error_code === 'string' ? data.error_code.trim().toLowerCase() : '';
  if (code) return code;
  if (status === 401) return 'session_expired';
  if (status === 403) return 'workspace_not_found';
  if ((status ?? 0) >= 500) return 'save_failed';
  return 'connection_failed';
}

/** The modal card name connectFix expects, for the route the panel used. */
function cardFor(kind: InboxKind | null | undefined, customDomain: boolean): string {
  if (!customDomain && (kind === 'gmail' || kind === 'icloud' || kind === 'yahoo' || kind === 'yandex' || kind === 'fastmail')) return kind;
  return 'generic';
}

const LINK_KINDS: Record<string, FailureLinkKind> = {
  'connect.fix.link.twoStep': 'twoStep',
  'connect.fix.link.appPasswords': 'appPasswords',
  'connect.fix.link.imapSetting': 'imapSetting',
  'connect.fix.link.providerHelp': 'providerHelp',
  'connect.fix.link.adminGuide': 'adminGuide',
};

const NOT_A_CREDENTIAL = new Set<FailureReason>(['imap_disabled', 'login_username_required', 'provider_refused_signin']);

export function describeConnectFailure(input: {
  result: ConnectResult;
  kind: InboxKind | null | undefined;
  customDomain?: boolean;
  providerLabel?: string | null;
  email?: string | null;
  imapHost?: string | null;
  smtpHost?: string | null;
  readOnly?: boolean;
}): ConnectFailure {
  const providerLabel = String(input.providerLabel ?? '');
  const base: ConnectFailure = {
    code: 'network', reason: null, phase: null, message: 'network', provider: providerLabel,
    links: [], passwordProblem: false, offerReadOnly: false, offerMicrosoft: false,
  };
  const { result } = input;
  if (!result || result.network) return base;

  const data = result.data ?? {};
  const code = failureCodeOf(result.status, data);
  const rawReason = typeof data.auth_reason === 'string' ? data.auth_reason : '';
  const reason = (FAILURE_REASONS as readonly string[]).includes(rawReason) ? (rawReason as FailureReason) : null;
  const phase = typeof data.phase === 'string' ? data.phase : null;
  const out: ConnectFailure = { ...base, code, reason: code === 'auth_failed' ? reason ?? 'password_rejected' : null, phase };

  const fixed = (message: FailureMessage, extra: Partial<ConnectFailure> = {}): ConnectFailure => ({ ...out, message, ...extra });
  switch (code) {
    case 'inbox_limit_reached': return fixed('limit');
    case 'session_expired': return fixed('sessionExpired');
    case 'insufficient_role': case 'workspace_not_found': return fixed('notAllowed');
    case 'login_already_connected': case 'inbox_exists_other_provider': return fixed('alreadyConnected');
    case 'microsoft_account_use_outlook': return fixed('useMicrosoft', { offerMicrosoft: true });
    default: break;
  }

  const fix = connectFix({
    card: cardFor(input.kind, input.customDomain === true),
    errorCode: code,
    reason,
    phase,
    host: typeof data.host === 'string' ? data.host : null,
    email: input.email ?? null,
    imapHost: input.imapHost ?? null,
    smtpHost: input.smtpHost ?? null,
    relayFailed: data.relay_failed === true,
    imapOk: data.imap_ok === true,
    connectionMode: input.readOnly ? 'imap' : 'both',
    providerLabel,
  });

  const links: FailureLink[] = (fix?.links ?? [])
    .filter((link) => LINK_KINDS[link.labelKey])
    .map((link) => ({ id: link.id, kind: LINK_KINDS[link.labelKey], url: link.url, provider: link.values?.provider ?? providerLabel }));
  const provider = (fix?.links?.[0]?.values?.provider ?? providerLabel) || providerLabel;

  if (fix?.action === 'use_outlook') return fixed('useMicrosoft', { offerMicrosoft: true, provider });

  const smtpSide = Boolean(phase && phase.startsWith('smtp_'));
  let message: FailureMessage;
  if (code === 'auth_failed') {
    if (fix?.row === 'smtp_rejected') message = 'smtpRejected';
    else message = `reason.${out.reason ?? 'password_rejected'}`;
  } else if (code === 'app_password_too_short') {
    message = 'reason.app_password_length';
  } else if (fix?.row === 'server_blocks_us') {
    message = 'blocked';
  } else if (fix?.row === 'host_not_found' || code === 'host_not_found') {
    message = 'hostNotFound';
  } else if (fix?.row === 'tls' || code === 'tls_handshake_failed') {
    message = 'tls';
  } else if (fix?.row === 'server_unreachable' || ['connection_refused', 'connection_timeout', 'imap_protocol_error', 'smtp_protocol_error'].includes(code)) {
    message = 'unreachable';
  } else if (['port_not_allowed', 'host_not_allowed', 'host_invalid', 'own_site_host'].includes(code)) {
    message = 'hostRefused';
  } else if (code === 'save_failed') {
    message = 'saveFailed';
  } else {
    message = 'generic';
  }

  const passwordProblem = Boolean(fix?.passwordProblem)
    || (code === 'auth_failed' && !NOT_A_CREDENTIAL.has(out.reason as FailureReason) && message !== 'smtpRejected');
  // Reading only helps when the reading half is not what failed: the sending
  // half refused, or the server could not be reached for sending.
  const offerReadOnly = !input.readOnly && (Boolean(fix?.offerReceiveOnly) || message === 'smtpRejected' || (smtpSide && !passwordProblem));

  return { ...out, message, provider, links, passwordProblem, offerReadOnly };
}
