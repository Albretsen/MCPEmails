/**
 * The support ticket behind "Send this error to support" on the onboarding
 * inbox step (app/api/onboarding/connect-help). Pure: closed-list facts in,
 * the /help form's body out. The password is never an input, and nothing the
 * mail server said is either: only the route's own codes and the host name.
 */
import { INBOX_KINDS } from './inbox-detect.ts';
import { FAILURE_REASONS } from './connect-failure.ts';

const SAFE_PHASES = new Set([
  'tcp', 'tls', 'greeting', 'authentication', 'smtp_tcp', 'smtp_tls', 'smtp_greeting', 'smtp_authentication',
]);
const NOTE_MAX = 1000;

export interface ConnectHelpTicket {
  category: 'connect';
  subject: string;
  message: string;
  from: 'onboarding';
  provider: string;
  code: string;
}

function slug(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/.test(value) ? value : null;
}

function hostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  return host.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

export function buildConnectHelpTicket(body: unknown): ConnectHelpTicket | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const provider = slug(input.provider);
  const code = slug(input.code);
  if (!provider || !(INBOX_KINDS as readonly string[]).includes(provider) || !code) return null;
  const reason = slug(input.reason);
  const phase = slug(input.phase);
  const host = hostname(input.host);
  const attempts = Number.isInteger(input.attempts) ? Math.min(Math.max(Number(input.attempts), 1), 99) : null;
  const note = typeof input.note === 'string' ? input.note.replace(/\r\n?/g, '\n').trim().slice(0, NOTE_MAX) : '';

  const lines = [
    'Sent from the onboarding inbox step after repeated connect failures.',
    `Provider panel: ${provider}`,
    `Error code: ${code}`,
  ];
  if (reason && (FAILURE_REASONS as readonly string[]).includes(reason)) lines.push(`Auth reason: ${reason}`);
  if (phase && SAFE_PHASES.has(phase)) lines.push(`Phase: ${phase}`);
  if (host) lines.push(`Server: ${host}`);
  if (attempts) lines.push(`Failed attempts: ${attempts}`);
  if (note) lines.push('', 'Note from the user:', note);

  return {
    category: 'connect',
    subject: `Connect failed: ${provider} (${code})`,
    message: lines.join('\n'),
    from: 'onboarding',
    provider,
    code,
  };
}
