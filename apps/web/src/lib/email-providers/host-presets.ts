// `SmtpSecurity` is the same two-value transport union for both protocols; it
// lives in imap-presets because that module is already safe to import from the
// browser bundle, which validate-imap (net/tls) is not.
import type { SmtpSecurity as MailSecurity } from './imap-presets';

/**
 * Known IMAP/SMTP settings for hosting providers the generic connector meets.
 *
 * This is a different table from IMAP_PRESETS. That one lists the four branded
 * consumer services that get their own card in the connect modal, and its
 * entries are chosen by clicking a logo. This one is a lookup: the user types
 * an address or a host into the generic IMAP form and we recognise where the
 * mailbox actually lives.
 *
 * It exists because of what the failures look like. Generic IMAP succeeds only
 * a quarter of the time, and the recorded attempts are a user guessing: one
 * workspace made twelve consecutive attempts against imap.ionos.com, cycling
 * 993/implicit-TLS and 143/STARTTLS, when IONOS serves both and the password
 * was the problem all along. Every host in the list below was picked from that
 * failure data, not from a directory of mail providers, so each entry retires
 * a real set of failed attempts.
 *
 * The settings are the vendor-documented ones (2026). Where a provider
 * documents two working combinations we record the one that is documented
 * first, because the transport fallback (see email/transport-autodetect.ts)
 * will find the other on its own if the first does not answer.
 */
export interface MailHostPreset {
  /** Stable id, used in diagnostics. Never shown to a user. */
  id: string;
  /** Human-readable provider name, shown in the connect form. */
  label: string;
  /**
   * Email domains served by this provider. Matched exactly, so a customer on
   * their own domain is found through `hostSuffixes` instead.
   */
  domains?: readonly string[];
  /**
   * Mail hostnames this provider serves, matched as an exact host or as a
   * suffix (".mail.ovh.net" matches ex4.mail.ovh.net). This is the half that
   * catches custom-domain customers, who are most of the failures: they know
   * their mail host because their host told them, but not the port.
   */
  hostSuffixes?: readonly string[];
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  /**
   * True when the provider's ordinary account password cannot authenticate a
   * mail client, so a rejected login is a missing app password rather than a
   * typo. Only set where the provider actually enforces it; guessing here is
   * how the old one-size-fits-all error message misled people.
   */
  requiresAppPassword?: boolean;
  /** Where the user generates that app password, when one is required. */
  appPasswordHelpUrl?: string;
}

export const MAIL_HOST_PRESETS: readonly MailHostPreset[] = [
  {
    id: 'ionos',
    label: 'IONOS',
    domains: ['ionos.com', 'ionos.de', 'ionos.co.uk', '1and1.com'],
    hostSuffixes: ['imap.ionos.com', 'smtp.ionos.com', '.ionos.de', '.ionos.co.uk', '.1and1.com'],
    imapHost: 'imap.ionos.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ionos.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'hostinger',
    label: 'Hostinger',
    hostSuffixes: ['.hostinger.com', '.hostinger.co', 'imap.hostinger.com', 'smtp.hostinger.com'],
    imapHost: 'imap.hostinger.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.hostinger.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    /**
     * OVH Hosted Exchange, served from ex<N>.mail.ovh.net. Listed ahead of
     * OVH's shared hosting because the hostname is more specific and because
     * the settings genuinely differ: Exchange does not listen on 465 at all,
     * so the shared-hosting defaults produce a connection that hangs until it
     * times out. That is exactly the ex4.mail.ovh.net failure in the data.
     */
    id: 'ovh-exchange',
    label: 'OVH Hosted Exchange',
    hostSuffixes: ['.mail.ovh.net'],
    imapHost: 'ex.mail.ovh.net',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'ex.mail.ovh.net',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    id: 'ovh',
    label: 'OVH',
    hostSuffixes: ['ssl0.ovh.net', '.ovh.net', '.ovh.com'],
    imapHost: 'ssl0.ovh.net',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'ssl0.ovh.net',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'dreamhost',
    label: 'DreamHost',
    hostSuffixes: ['imap.dreamhost.com', 'smtp.dreamhost.com', '.dreamhost.com', '.dreamhostps.com'],
    imapHost: 'imap.dreamhost.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.dreamhost.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'titan',
    label: 'Titan Email',
    hostSuffixes: ['.titan.email'],
    imapHost: 'imap.titan.email',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.titan.email',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'privateemail',
    label: 'Namecheap Private Email',
    domains: ['privateemail.com'],
    hostSuffixes: ['.privateemail.com'],
    imapHost: 'mail.privateemail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.privateemail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'migadu',
    label: 'Migadu',
    hostSuffixes: ['.migadu.com'],
    imapHost: 'imap.migadu.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.migadu.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    /**
     * InMotion / Web Hosting Hub shared mail servers. The customer's control
     * panel hands them a secureNN.uhserver.com hostname, which is why the host
     * suffix is the only usable key: the address is always a custom domain.
     */
    id: 'uhserver',
    label: 'InMotion Hosting',
    hostSuffixes: ['.uhserver.com', 'uhserver.com'],
    imapHost: 'mail.uhserver.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.uhserver.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    /**
     * OpenSRS / Tucows hosted mail, resold under many registrars' names. The
     * cluster letter varies (mail.a, mail.b, …) and the customer must keep the
     * one they were given, so the resolved host is only a fallback for a user
     * who has none.
     */
    id: 'hostedemail',
    label: 'OpenSRS Hosted Email',
    hostSuffixes: ['.hostedemail.com'],
    imapHost: 'mail.hostedemail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.hostedemail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com', 'zoho.eu', 'zoho.in'],
    hostSuffixes: ['.zoho.com', '.zoho.eu', '.zoho.in', '.zoho.com.au', '.zoho.jp', '.zohocloud.ca'],
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://accounts.zoho.com/home#security/device_pass',
  },
  {
    id: 'gmx',
    label: 'GMX',
    domains: ['gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    hostSuffixes: ['.gmx.com', '.gmx.net', '.gmx.de'],
    imapHost: 'imap.gmx.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.gmx.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    id: 'mailcom',
    label: 'mail.com',
    domains: ['mail.com', 'email.com', 'usa.com', 'consultant.com'],
    hostSuffixes: ['imap.mail.com', 'smtp.mail.com'],
    imapHost: 'imap.mail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.mail.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    id: 'fastmail',
    label: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
    hostSuffixes: ['.fastmail.com', '.messagingengine.com'],
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://app.fastmail.com/settings/security/apppw',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    hostSuffixes: ['.mail.me.com'],
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://account.apple.com/account/manage',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com'],
    hostSuffixes: ['.mail.yahoo.com'],
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://login.yahoo.com/myaccount/security/app-password',
  },
  {
    id: 'yandex',
    label: 'Yandex Mail',
    domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
    hostSuffixes: ['.yandex.com', '.yandex.ru'],
    imapHost: 'imap.yandex.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.yandex.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://id.yandex.com/security/app-passwords',
  },
];

/** Lower-cased, trimmed, and with a trailing dot (a valid FQDN) removed. */
function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** The domain part of an address, or '' when the input is not one. */
export function emailDomain(email: string): string {
  const at = String(email ?? '').lastIndexOf('@');
  return at < 0 ? '' : normalizeHostname(email.slice(at + 1));
}

function matchesHost(preset: MailHostPreset, host: string): boolean {
  if (!host || !preset.hostSuffixes) return false;
  return preset.hostSuffixes.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix
  );
}

function matchesDomain(preset: MailHostPreset, domain: string): boolean {
  return Boolean(domain) && Boolean(preset.domains?.includes(domain));
}

/**
 * Find the provider serving a mailbox, from the address the user typed and/or
 * the mail host they typed.
 *
 * The host wins when both are present and both match, because a custom domain
 * says nothing about where its mail lives while a hostname is the mail server
 * itself. Entries are scanned in table order, so a more specific host suffix
 * must be listed ahead of the general one it sits inside (OVH's Hosted
 * Exchange ahead of OVH).
 */
export function findMailHostPreset(input: { email?: string | null; host?: string | null }): MailHostPreset | null {
  const host = normalizeHostname(String(input.host ?? ''));
  const domain = emailDomain(String(input.email ?? ''));

  const byHost = MAIL_HOST_PRESETS.find((preset) => matchesHost(preset, host));
  if (byHost) return byHost;

  // An address on the provider's own domain, e.g. someone@gmx.net.
  const byDomain = MAIL_HOST_PRESETS.find((preset) => matchesDomain(preset, domain));
  if (byDomain) return byDomain;

  // Last resort: a custom domain whose *mail* is delegated to a provider we
  // know, which we can only see if the domain itself sits under the provider's
  // (e.g. a subdomain of migadu.com). Deliberately not a heuristic on the
  // second-level label: guessing a host from a domain name is how a user ends
  // up authenticating against a stranger's server.
  return MAIL_HOST_PRESETS.find((preset) => matchesHost(preset, domain)) ?? null;
}

/**
 * The connect-form values implied by a recognised provider: both hosts, both
 * ports and both security modes, ready to prefill.
 */
export function prefillFromEmail(email: string): {
  provider: string;
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: MailSecurity;
  requiresAppPassword: boolean;
  appPasswordHelpUrl: string | null;
} | null {
  const preset = findMailHostPreset({ email });
  if (!preset) return null;
  return {
    provider: preset.id,
    label: preset.label,
    imapHost: preset.imapHost,
    imapPort: preset.imapPort,
    imapSecurity: preset.imapSecurity,
    smtpHost: preset.smtpHost,
    smtpPort: preset.smtpPort,
    smtpSecurity: preset.smtpSecurity,
    requiresAppPassword: preset.requiresAppPassword === true,
    appPasswordHelpUrl: preset.appPasswordHelpUrl ?? null,
  };
}
