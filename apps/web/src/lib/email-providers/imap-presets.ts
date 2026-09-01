/**
 * IMAP/SMTP host presets for branded providers connected via app password.
 *
 * Every provider here is served through the single `provider = 'imap'` transport
 * (see Documents/provider-support.md §3). The branded name is stored in
 * `inboxes.service` for UX/icon selection; the resolved host/port values below
 * are persisted onto the inbox row at connect-time so the edge function never
 * needs to know the brand.
 *
 * Settings verified against vendor documentation (2026). Every provider here
 * requires the user to enable 2FA and generate an app-specific password; their
 * main account password will not authenticate from a third-party client.
 */

/** Branded IMAP services with fixed host presets, plus the user-supplied catch-all. */
export type ImapService = 'gmail' | 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic';

/** Branded services that have a fixed host preset (excludes the generic catch-all). */
export type BrandedImapService = Exclude<ImapService, 'generic'>;

/**
 * SMTP transport security:
 *  - 'tls'      → implicit TLS, connect over TLS from the first byte (port 465)
 *  - 'starttls' → plaintext connect, upgrade via STARTTLS (port 587)
 */
export type SmtpSecurity = 'tls' | 'starttls';

export interface ImapPreset {
  /** Stored in inboxes.service. */
  service: BrandedImapService;
  /** Human-readable name for the dashboard and connect modal. */
  label: string;
  /** ProviderLogo `kind` for this service. */
  logoKind: string;
  imapHost: string;
  /** Implicit TLS (port 993) for all current presets. */
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  /** Where the user generates an app-specific password. */
  appPasswordHelpUrl: string;
  /** Short connect-modal guidance shown under the credentials form. */
  hint: string;
}

export const IMAP_PRESETS: Record<BrandedImapService, ImapPreset> = {
  gmail: {
    /**
     * Gmail leads the branded presets because an app password is now the
     * DEFAULT way to connect a Google mailbox here, and OAuth the secondary
     * one. That is not a preference, it is arithmetic: an unverified Google
     * app has a 100-user LIFETIME cap on consent grants that cannot be reset,
     * 71 of those grants are already spent, and lifting the cap means Google's
     * restricted-scope review, which requires a paid annual CASA assessment.
     * An app password is not OAuth at all: no scopes, no consent screen, no
     * review, no cap.
     *
     * The 56 inboxes already connected over OAuth are untouched. They keep
     * provider = 'gmail' and their tokens; only new connections land here, as
     * provider = 'imap' with service = 'gmail'.
     */
    service: 'gmail',
    label: 'Gmail',
    logoKind: 'gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    appPasswordHelpUrl: 'https://myaccount.google.com/apppasswords',
    hint:
      'Requires 2-Step Verification on the Google account: the app password ' +
      'option does not exist until it is on. Google Workspace administrators ' +
      'can switch app passwords off for a whole domain.',
  },
  icloud: {
    service: 'icloud',
    label: 'iCloud Mail',
    logoKind: 'icloud',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    appPasswordHelpUrl: 'https://support.apple.com/en-us/102654',
    hint:
      'Requires two-factor authentication. Generate an app-specific password at ' +
      'appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
  },
  yahoo: {
    service: 'yahoo',
    label: 'Yahoo Mail',
    logoKind: 'yahoo',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    appPasswordHelpUrl: 'https://help.yahoo.com/kb/SLN15241.html',
    hint:
      'Requires two-step verification. Generate an app password in Yahoo Account ' +
      'Security. Yahoo allows at most 5 simultaneous connections.',
  },
  zoho: {
    service: 'zoho',
    label: 'Zoho Mail',
    logoKind: 'zoho',
    // Defaults to the global (.com) data center, personal account type.
    // Region-specific hosts (imap.zoho.eu, imap.zoho.in, imap.zoho.com.au,
    // imap.zoho.jp, imap.zohocloud.ca, …) are handled by the region selector.
    // Custom-domain / organization accounts use the `imappro`/`smtppro` hosts
    // for the same data center — see zohoHosts() below.
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    appPasswordHelpUrl: 'https://www.zoho.com/mail/help/imap-access.html',
    hint:
      'Enable IMAP access in Zoho first (Settings → Mail Accounts → IMAP Access ' +
      'is OFF by default). If two-factor authentication is enabled, also generate ' +
      'an application-specific password in Zoho Account → Security.',
  },
  yandex: {
    service: 'yandex',
    label: 'Yandex Mail',
    logoKind: 'yandex',
    imapHost: 'imap.yandex.com',
    imapPort: 993,
    smtpHost: 'smtp.yandex.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    appPasswordHelpUrl: 'https://yandex.com/support/id/en/authorization/app-passwords.html',
    hint:
      'In Yandex Mail → Settings, enable IMAP and turn on "App passwords and OAuth ' +
      'tokens" (both are required). Then generate an app password in Yandex ID → ' +
      'Security. Yandex 360 custom-domain accounts can set a login below if it ' +
      'differs from the email.',
  },
};

/** Default host/port hints for the generic connector form (user-overridable). */
export const GENERIC_IMAP_DEFAULTS = {
  imapPort: 993,
  smtpPort: 465,
  smtpSecurity: 'tls' as SmtpSecurity,
};

/**
 * Zoho hosts a given account in one of several regional data centers, and the
 * IMAP/SMTP hostname follows the data center's TLD. The user must pick the
 * region their account lives in (shown in Zoho → Settings → Mail Accounts).
 * Ports are 993/465 across all regions.
 */
export interface ZohoRegion {
  value: string;
  label: string;
  imapHost: string;
  smtpHost: string;
}

export const ZOHO_REGIONS: ZohoRegion[] = [
  { value: 'com', label: 'United States / Global (zoho.com)', imapHost: 'imap.zoho.com', smtpHost: 'smtp.zoho.com' },
  { value: 'eu', label: 'Europe (zoho.eu)', imapHost: 'imap.zoho.eu', smtpHost: 'smtp.zoho.eu' },
  { value: 'in', label: 'India (zoho.in)', imapHost: 'imap.zoho.in', smtpHost: 'smtp.zoho.in' },
  { value: 'com.au', label: 'Australia (zoho.com.au)', imapHost: 'imap.zoho.com.au', smtpHost: 'smtp.zoho.com.au' },
  { value: 'jp', label: 'Japan (zoho.jp)', imapHost: 'imap.zoho.jp', smtpHost: 'smtp.zoho.jp' },
  { value: 'ca', label: 'Canada (zohocloud.ca)', imapHost: 'imap.zohocloud.ca', smtpHost: 'smtp.zohocloud.ca' },
];

export const DEFAULT_ZOHO_REGION = 'com';

/** Resolve a Zoho region by value, falling back to the global (.com) data center. */
export function zohoRegion(value: string | undefined | null): ZohoRegion {
  return ZOHO_REGIONS.find((r) => r.value === value) ?? ZOHO_REGIONS[0];
}

/**
 * Zoho serves two classes of mailbox on different hosts within each data center:
 *
 *  - 'personal'      → @zohomail.com / free accounts: imap.zoho.<tld>  / smtp.zoho.<tld>
 *  - 'organization'  → paid custom-domain (you@yourdomain): imappro.zoho.<tld> / smtppro.zoho.<tld>
 *
 * The organization host is the personal host with the leading service prefix
 * promoted to its "pro" variant (imap → imappro, smtp → smtppro). This holds
 * across every data center TLD, including Canada's imap.zohocloud.ca →
 * imappro.zohocloud.ca. Ports are 993/465 regardless of account type.
 *
 * Verified against Zoho's IMAP/SMTP configuration docs (2026):
 * https://www.zoho.com/mail/help/imap-access.html
 */
export type ZohoAccountType = 'personal' | 'organization';

export const DEFAULT_ZOHO_ACCOUNT_TYPE: ZohoAccountType = 'personal';

/** Type guard for the accepted Zoho account-type values. */
export function isZohoAccountType(value: unknown): value is ZohoAccountType {
  return value === 'personal' || value === 'organization';
}

/**
 * Promote a personal Zoho host to its organization ("pro") equivalent by
 * transforming the documented prefix: imap → imappro, smtp → smtppro. The
 * data-center suffix (e.g. `.zoho.eu`, `.zohocloud.ca`) is preserved verbatim.
 * Any host that doesn't begin with a known prefix is returned unchanged.
 */
function toProHost(host: string): string {
  if (host.startsWith('imap.')) return 'imappro.' + host.slice('imap.'.length);
  if (host.startsWith('smtp.')) return 'smtppro.' + host.slice('smtp.'.length);
  return host;
}

/**
 * Resolve the Zoho IMAP/SMTP hosts for a given data-center region and account
 * type. Personal accounts use the region's documented hosts as-is; organization
 * (custom-domain) accounts use the `imappro`/`smtppro` variants. Defaults to the
 * global (.com) region and personal account type when inputs are absent.
 */
export function zohoHosts(
  region: string | undefined | null,
  accountType: ZohoAccountType = DEFAULT_ZOHO_ACCOUNT_TYPE
): { imapHost: string; smtpHost: string } {
  const r = zohoRegion(region);
  if (accountType === 'organization') {
    return { imapHost: toProHost(r.imapHost), smtpHost: toProHost(r.smtpHost) };
  }
  return { imapHost: r.imapHost, smtpHost: r.smtpHost };
}

/** Type guard: is the given string a branded service with a fixed preset? */
export function isBrandedImapService(value: string): value is BrandedImapService {
  return (
    value === 'gmail' ||
    value === 'icloud' ||
    value === 'yahoo' ||
    value === 'zoho' ||
    value === 'yandex'
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Connect-form ergonomics
 *
 * Both helpers below exist because of what production failures actually look
 * like, not because of a hypothetical. See the notes on each.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The conventional port for each transport security mode.
 *
 * The generic IMAP form let the port and the security mode drift apart, and
 * that mismatch was the single largest source of failed generic connections:
 * picking STARTTLS while the port stayed 993 makes us open a plaintext socket
 * to a TLS-only listener, so the server never speaks and the attempt dies as
 * CONNECTION_TIMEOUT in the `greeting` phase (22 recorded failures). The
 * mirror image, implicit TLS against 143, fails the handshake instead
 * (13 recorded failures at phase `tls`). Together that was two thirds of all
 * non-credential generic IMAP failures, and neither error text could tell the
 * user which of the two fields to change.
 *
 * Keeping the pair in step in the form removes the mismatch at the source.
 */
export const MAIL_PORTS: Record<'imap' | 'smtp', Record<SmtpSecurity, number>> = {
  imap: { tls: 993, starttls: 143 },
  smtp: { tls: 465, starttls: 587 },
};

/** Conventional port for a protocol/security pair. */
export function portForSecurity(protocol: 'imap' | 'smtp', security: SmtpSecurity): number {
  return MAIL_PORTS[protocol][security];
}

/**
 * The security mode conventionally served on a port, or null when the port is
 * not one of the two well-known ones (a custom port carries no implication, so
 * the user's explicit choice must stand).
 */
export function securityForPort(protocol: 'imap' | 'smtp', port: number): SmtpSecurity | null {
  const ports = MAIL_PORTS[protocol];
  if (port === ports.tls) return 'tls';
  if (port === ports.starttls) return 'starttls';
  return null;
}

/**
 * Strip whitespace from an app-specific password.
 *
 * Every provider we offer an app-password flow for generates a token out of a
 * fixed alphabet and none of them include a space in it, but several *display*
 * the token in groups (Google separates four blocks with spaces, Apple with
 * hyphens) and password managers and PDF viewers readily add a trailing
 * newline or a non-breaking space when the value is copied. Those characters
 * reach the IMAP server inside the SASL token and come back as an ordinary
 * `NO [AUTHENTICATIONFAILED]`, which is indistinguishable from a wrong
 * password, so the user is told to check a password that is in fact correct.
 *
 * Only internal *whitespace* is removed: hyphens are left alone because Apple
 * app-specific passwords legitimately contain them.
 *
 * This deliberately does NOT apply to the generic IMAP/SMTP connector, where
 * the credential is a real account password that may contain spaces on purpose.
 */
export function normalizeAppPassword(value: string): string {
  // \s misses the zero-width and BOM characters that copy-paste introduces.
  return value.replace(/[\s\u00a0\u200b-\u200d\ufeff]/g, '');
}
