import type { MailSecurity } from './validate-imap';

export function normalizeSecurity(value: unknown, fallback: MailSecurity = 'tls'): MailSecurity {
  return value === 'starttls' || value === 'tls' ? value : fallback;
}

export function legacySecurityForPort(port: number, protocol: 'imap' | 'smtp'): MailSecurity {
  if (protocol === 'imap') return port === 143 ? 'starttls' : 'tls';
  return port === 587 ? 'starttls' : 'tls';
}

export function yandexLoginUsername(email: string, accountType: 'personal' | 'business', override?: string | null): string {
  const manual = override?.trim();
  if (manual) return manual;
  return accountType === 'business' ? email : email.split('@')[0];
}

const SAFE_PHASES = new Set(['tcp', 'tls', 'greeting', 'authentication', 'smtp_tcp', 'smtp_tls', 'smtp_greeting', 'smtp_authentication', 'authorization', 'token_exchange', 'persistence', 'complete']);
export function safeDiagnosticPhase(value: unknown): string | null {
  return typeof value === 'string' && SAFE_PHASES.has(value) ? value : null;
}
