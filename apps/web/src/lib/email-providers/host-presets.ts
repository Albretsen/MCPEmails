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
  /**
   * MX hostnames this provider publishes, matched the same way as
   * `hostSuffixes`. Only present where the MX name cannot be reached through
   * `hostSuffixes`, which is most of the table: Migadu answers MX with
   * aspmx1.migadu.com and Zoho with mx.zoho.com, both of which already end in
   * a listed suffix, so they need nothing here.
   *
   * The two that do are the two that matter most for a business mailbox on a
   * custom domain, and they were checked against live DNS rather than
   * documentation:
   *   dig MX stripe.com  -> aspmx.l.google.com, alt1.aspmx.l.google.com
   *   dig MX icloud.com  -> mx01.mail.icloud.com, mx02.mail.icloud.com
   * Neither name shares a label with the provider's IMAP host, so without this
   * field a Google Workspace domain resolves to nothing and the user is left
   * guessing at settings we already know.
   */
  mxSuffixes?: readonly string[];
  /**
   * Set when an MX name that matches this entry does NOT identify it, so MX
   * lookup must skip it. Exactly one entry needs this: OVH serves both Hosted
   * Exchange and shared hosting from mail.ovh.net, the two need different SMTP
   * settings (Exchange does not listen on 465 at all), and the MX name alone
   * cannot tell them apart. Skipping the Exchange entry lets an ambiguous
   * .mail.ovh.net MX fall through to the shared-hosting one, which is the far
   * more common mailbox and whose settings the transport fallback can recover
   * from; filling in Exchange's host for a shared-hosting customer could not
   * be recovered from, because the hostname itself would be wrong.
   */
  mxAmbiguous?: boolean;
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
  // IONOS runs two mail platforms, and the host names are not interchangeable
  // labels for one server. The .com names (imap.ionos.com, mx00.ionos.com)
  // resolve to 74.208.x and present a certificate issued to IONOS Inc. (US);
  // the European names (.de, .co.uk, .fr, .es, .it, and the old 1und1/1and1
  // ones) resolve to 212.227.x and present one issued to IONOS SE. Each
  // country's help page documents its own names: ionos.de lists imap.ionos.de
  // and smtp.ionos.de, ionos.co.uk lists imap.ionos.co.uk, ionos.com lists
  // imap.ionos.com. This used to be one entry that answered imap.ionos.com for
  // every one of them, so a German custom domain (MX mx00.ionos.de) was
  // prefilled with the US host. In production every connected .de address on
  // IONOS uses imap.ionos.de or imap.1und1.de, and none uses imap.ionos.com.
  // `id` stays 'ionos' on the US entry so diagnostics keep their history.
  {
    id: 'ionos-de',
    label: 'IONOS',
    domains: ['ionos.de'],
    hostSuffixes: ['.ionos.de', '.1und1.de'],
    // The pre-rebrand MX name some older German 1&1 domains still publish.
    mxSuffixes: ['.kundenserver.de'],
    imapHost: 'imap.ionos.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ionos.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'ionos-uk',
    label: 'IONOS',
    domains: ['ionos.co.uk'],
    hostSuffixes: ['.ionos.co.uk', '.1and1.co.uk'],
    imapHost: 'imap.ionos.co.uk',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ionos.co.uk',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'ionos-fr',
    label: 'IONOS',
    domains: ['ionos.fr'],
    hostSuffixes: ['.ionos.fr', '.1and1.fr'],
    imapHost: 'imap.ionos.fr',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ionos.fr',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'ionos-es',
    label: 'IONOS',
    domains: ['ionos.es'],
    hostSuffixes: ['.ionos.es', '.1and1.es'],
    imapHost: 'imap.ionos.es',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ionos.es',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'ionos-it',
    label: 'IONOS',
    domains: ['ionos.it'],
    hostSuffixes: ['.ionos.it', '.1and1.it'],
    imapHost: 'imap.ionos.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ionos.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'ionos',
    label: 'IONOS',
    domains: ['ionos.com', '1and1.com'],
    hostSuffixes: ['imap.ionos.com', 'smtp.ionos.com', '.1and1.com'],
    // mx00.ionos.com / mx01.ionos.com: a US custom domain. Not a hostSuffix,
    // because a typed "something.ionos.com" host is not evidence of anything.
    mxSuffixes: ['.ionos.com'],
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
    mxAmbiguous: true,
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
    /**
     * Gmail. The only entry here that was not drawn from the failure log,
     * because until now a Google mailbox could not be connected any way but
     * OAuth, so there were no generic-form attempts to record. It is in the
     * table for the same reason every other branded service is: an address or
     * a host is what identifies the mailbox, and someone who types
     * me@gmail.com into the generic form has to get the same "your account
     * password will never work here" answer as someone who clicked the Gmail
     * card. Without the entry they would get the default advice to re-check a
     * password that cannot authenticate.
     *
     * Google Workspace custom domains are found through the host suffixes:
     * their address says nothing, but their mail server is imap.gmail.com.
     */
    id: 'gmail',
    label: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    hostSuffixes: ['.gmail.com', '.googlemail.com'],
    // What a Workspace domain publishes: aspmx.l.google.com and its alt1..alt4
    // siblings, plus the newer single-record smtp.google.com.
    mxSuffixes: ['.l.google.com', 'smtp.google.com', '.googlemail.com'],
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    hostSuffixes: ['.mail.me.com'],
    // iCloud+ Custom Email Domain publishes mx01/mx02.mail.icloud.com.
    mxSuffixes: ['.mail.icloud.com'],
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
  // ── Providers whose fix steps the connect panel names (CONNECT_FIX_PROVIDERS
  // in lib/email/auth-failure-help.ts). Hosts are the registry's verified
  // values (src/lib/connect/providers.mjs); the app-password flags and links
  // agree with the panel, which a test checks. Each is a host people typed
  // into the generic form and then failed on with the account password.
  {
    // AOL runs on Yahoo's platform but issues its own app passwords.
    id: 'aol',
    label: 'AOL Mail',
    domains: ['aol.com', 'aim.com'],
    hostSuffixes: ['imap.aol.com', 'smtp.aol.com'],
    imapHost: 'imap.aol.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.aol.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://login.aol.com/myaccount/security/app-password',
  },
  {
    // The website password is refused by mail clients; a "password for
    // external applications" is required (help.mail.ru, mail clients page).
    id: 'mail-ru',
    label: 'Mail.ru',
    domains: ['mail.ru', 'bk.ru', 'list.ru', 'inbox.ru'],
    hostSuffixes: ['imap.mail.ru', 'smtp.mail.ru'],
    imapHost: 'imap.mail.ru',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.mail.ru',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://help.mail.ru/mail/login/mailer/',
  },
  {
    // Tencent issues a 16-character authorization code once IMAP is on.
    id: 'qq',
    label: 'QQ Mail',
    domains: ['qq.com', 'foxmail.com'],
    hostSuffixes: ['imap.qq.com', 'smtp.qq.com'],
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://help.mail.qq.com/detail/106/985',
  },
  {
    // Only the "Passwort für E-Mail-Programme" authenticates, never the
    // Telekom Login password. Telekom's help articles sit behind a sign-in
    // check that could not be verified, so the link is the help root.
    id: 't-online',
    label: 'T-Online',
    domains: ['t-online.de', 'magenta.de'],
    hostSuffixes: ['secureimap.t-online.de', 'securesmtp.t-online.de'],
    imapHost: 'secureimap.t-online.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'securesmtp.t-online.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://www.telekom.de/hilfe',
  },
  {
    // Each address issues its own device passwords; the Manager login is refused.
    id: 'infomaniak',
    label: 'Infomaniak',
    domains: ['ik.me'],
    hostSuffixes: ['mail.infomaniak.com'],
    imapHost: 'mail.infomaniak.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.infomaniak.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://www.infomaniak.com/en/support/faq/1321/add-a-device-create-a-mail-password-from-the-mail-service',
  },
  {
    // POP/IMAP is off by default; the "mot de passe dédié" is recommended, but
    // the account password is not refused outright, so no flag.
    id: 'orange',
    label: 'Orange',
    domains: ['orange.fr', 'wanadoo.fr'],
    hostSuffixes: ['imap.orange.fr', 'smtp.orange.fr'],
    imapHost: 'imap.orange.fr',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.orange.fr',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // The account password works until two-factor is on; then an app password.
    id: 'seznam',
    label: 'Seznam',
    domains: ['seznam.cz', 'email.cz'],
    hostSuffixes: ['imap.seznam.cz', 'smtp.seznam.cz'],
    imapHost: 'imap.seznam.cz',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.seznam.cz',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Same house rule as GMX: POP3/IMAP access starts switched off.
    id: 'web-de',
    label: 'WEB.DE',
    domains: ['web.de'],
    hostSuffixes: ['imap.web.de', 'smtp.web.de'],
    imapHost: 'imap.web.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.web.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
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
 * Find the provider from an MX hostname the domain publishes.
 *
 * Separate from findMailHostPreset because an MX name is a different kind of
 * evidence from a mail host. It is authoritative about who RECEIVES the
 * domain's mail, which for every provider in this table is the same company
 * that serves its IMAP, but the name itself is usually not one a user would
 * ever type: nobody connects to aspmx.l.google.com. So `mxSuffixes` is checked
 * first (it exists precisely for names that share nothing with the IMAP host),
 * and only then does it fall back to the ordinary host match, which the
 * majority of the table already satisfies (aspmx1.migadu.com ends in
 * ".migadu.com", mx.zoho.com in ".zoho.com", in1-smtp.messagingengine.com in
 * ".messagingengine.com").
 *
 * Entries flagged `mxAmbiguous` are excluded: see the field's own comment for
 * the one case, which is OVH.
 */
export function findMailHostPresetByMx(exchange: string): MailHostPreset | null {
  const host = normalizeHostname(String(exchange ?? ''));
  if (!host) return null;
  const byMx = MAIL_HOST_PRESETS.find(
    (preset) =>
      preset.mxSuffixes?.some((suffix) =>
        suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix
      ) === true
  );
  if (byMx) return byMx;
  return MAIL_HOST_PRESETS.find((preset) => !preset.mxAmbiguous && matchesHost(preset, host)) ?? null;
}

/**
 * The connect-form values implied by a recognised provider: both hosts, both
 * ports and both security modes, ready to prefill.
 */
export interface MailHostPrefill {
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
}

/** The same shape, from a preset that was found by some other route. */
export function prefillFromPreset(preset: MailHostPreset): MailHostPrefill {
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

/**
 * The table lookup keyed by the address domain alone.
 *
 * The autodiscovery route never receives the local part of an address (there
 * is nothing it could do with one), so it needs a way in that does not require
 * inventing a fake mailbox name to satisfy `prefillFromEmail`.
 */
export function prefillFromDomain(domain: string): MailHostPrefill | null {
  const preset = findMailHostPreset({ email: `x@${normalizeHostname(String(domain ?? ''))}` });
  return preset ? prefillFromPreset(preset) : null;
}

export function prefillFromEmail(email: string): MailHostPrefill | null {
  const preset = findMailHostPreset({ email });
  return preset ? prefillFromPreset(preset) : null;
}
