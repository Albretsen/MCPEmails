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

/** Upper bound on a stored auth diagnostic, long enough for a code plus reason. */
const AUTH_DIAGNOSTIC_MAX_LENGTH = 160;

/**
 * Reduce a mail server's rejection of a login to a storable diagnostic.
 *
 * A tagged `NO`/`BAD` line is the only thing that separates a systemic,
 * provider-wide failure (every user of a service failing identically) from an
 * ordinary mistyped password, so discarding it entirely leaves a 100%-failure
 * provider indistinguishable from user error. Storing it verbatim is not an
 * option either: the text is server-controlled and may echo the login back.
 *
 * The text is therefore reduced to a bounded, non-identifying form: the tagged
 * status, plus the server's reason with the submitted credentials removed,
 * anything address-shaped masked, control characters flattened, and the result
 * truncated. `secrets` must carry every value that was sent to the server (the
 * SASL username and the password) so none of them can survive into storage.
 */
export function sanitizeAuthDiagnostic(
  status: string,
  text: string,
  secrets: readonly (string | null | undefined)[] = []
): string {
  const tag = /^(OK|NO|BAD)$/i.test(status) ? status.toUpperCase() : 'UNKNOWN';

  // Strip the exact submitted values first: a username may itself be an address,
  // and a password could in principle appear in an echoed command.
  let reason = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) {
      reason = reason.split(secret).join('<redacted>');
    }
  }

  reason = reason
    // Anything address-shaped, whether or not it was the login we sent.
    .replace(/[^\s<>()[\]:;,"']+@[^\s<>()[\]:;,"']+/g, '<address>')
    // A SASL PLAIN token is base64 of "\0user\0password", so a server that
    // echoes the offending AUTHENTICATE command back (exactly what a syntax
    // error like Yandex's "BAD AUTHENTICATE Command syntax error" invites)
    // would otherwise persist the credential in trivially reversible form.
    // Redacting the exact token above is not enough: any re-encoding, wrapping
    // or partial echo would slip past a literal match.
    //
    // The shape test is deliberately narrow so it removes tokens without
    // eating diagnostics: a run must be long AND mix upper, lower and digit.
    // That spares the codes worth keeping, e.g. "AUTHENTICATIONFAILED" (no
    // lowercase, no digit) and "LOGINDISABLED".
    .replace(/[A-Za-z0-9+/]{20,}={0,2}/g, (run) =>
      /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) ? '<token>' : run
    )
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const combined = reason ? `${tag} ${reason}` : tag;
  return combined.length > AUTH_DIAGNOSTIC_MAX_LENGTH
    ? `${combined.slice(0, AUTH_DIAGNOSTIC_MAX_LENGTH - 1)}…`
    : combined;
}
