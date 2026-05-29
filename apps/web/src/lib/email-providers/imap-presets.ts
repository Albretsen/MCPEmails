/**
 * IMAP/SMTP host presets for branded providers connected via app password.
 *
 * Every provider here is served through the single `provider = 'imap'` transport
 * (see Documents/provider-support.md §3). The branded name is stored in
 * `inboxes.service` for UX/icon selection; the resolved host/port values below
 * are persisted onto the inbox row at connect-time so the edge function never
 * needs to know the brand.
 *
 * Settings verified against vendor documentation (2026). All four providers
 * require the user to enable 2FA and generate an app-specific password — their
 * main account password will not authenticate from a third-party client.
 */

/** Branded IMAP services with fixed host presets, plus the user-supplied catch-all. */
export type ImapService = 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic';

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
    // Defaults to the global (.com) data center. Region-specific hosts
    // (imap.zoho.eu, imap.zoho.in, imap.zoho.com.au, imap.zoho.jp, …) are
    // handled by the region selector added in Phase 4.
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    appPasswordHelpUrl: 'https://www.zoho.com/mail/help/imap-access.html',
    hint:
      'If two-factor authentication is enabled, generate an application-specific ' +
      'password in Zoho Account → Security.',
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
      'Enable IMAP in Yandex Mail settings first, then generate an app password ' +
      'in Yandex ID → Security.',
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

/** Type guard: is the given string a branded service with a fixed preset? */
export function isBrandedImapService(value: string): value is BrandedImapService {
  return value === 'icloud' || value === 'yahoo' || value === 'zoho' || value === 'yandex';
}
