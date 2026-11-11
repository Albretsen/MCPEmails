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

/** Telekom's help article on the separate password for mail programs. */
export const TELEKOM_MAIL_PASSWORD_HELP = 'https://www.telekom.de/hilfe/apps-dienste/e-mail/programm-passwort-verwalten';

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
    // IONOS Microsoft Exchange, a separate product from IONOS mail. Probed on
    // 2026-11-04: Exchange IMAP4 on 993 (TLS) and submission on 587
    // (STARTTLS), certificate issued to IONOS SE. Three production inboxes use
    // these settings. Exchange does not listen for implicit TLS on 465.
    id: 'ionos-exchange',
    label: 'IONOS Exchange',
    hostSuffixes: ['exchange.ionos.eu'],
    imapHost: 'exchange.ionos.eu',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'exchange.ionos.eu',
    smtpPort: 587,
    smtpSecurity: 'starttls',
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
     * UOL Host, UOL's business mail on the customer's own domain (Brazil).
     * uhserver.com is UOL's domain (its NS are ns*.host.uol.com.br), not
     * InMotion's, which this entry used to claim. The old host was wrong too:
     * mail.uhserver.com is a CNAME to UOL's webmail load balancer and does not
     * listen on 993, and the secureNN.uhserver.com names do not exist in DNS.
     * The hosts below were probed live on 2026-11-04 (certificate SAN covers
     * both) and are the ones every connected UOL Host inbox in production uses.
     * The address is always a custom domain, so the host is the only key.
     */
    id: 'uhserver',
    label: 'UOL Host',
    hostSuffixes: ['.uhserver.com'],
    imapHost: 'imap.uhserver.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtps.uhserver.com',
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
    // GMX's German platform (gmx.de, gmx.net, gmx.at, gmx.ch). GMX's own
    // German help (hilfe.gmx.net, IMAP-Serverdaten) documents imap.gmx.net and
    // mail.gmx.net, with 465/SSL as the documented alternative to 587, and the
    // registry and the /connect/gmx page say the same. This entry used to give
    // these addresses the .com hosts, so the lookup tool answered differently
    // for gmx.net and gmx.de.
    id: 'gmx',
    label: 'GMX',
    domains: ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    hostSuffixes: ['.gmx.net', '.gmx.de'],
    imapHost: 'imap.gmx.net',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.gmx.net',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // gmx.com, GMX's international platform, documents its own .com hosts.
    // German accounts also log in there (13 connected inboxes do), so a typed
    // imap.gmx.com still counts as GMX.
    id: 'gmx-com',
    label: 'GMX',
    domains: ['gmx.com'],
    hostSuffixes: ['.gmx.com'],
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
    // Yahoo's country domains all live on the same platform. yahoo.com.br is
    // the largest .br group in production. Yahoo! JAPAN (yahoo.co.jp) is a
    // different company and platform with no app passwords; see 'yahoo-jp'.
    domains: [
      'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.com.br', 'yahoo.com.ar', 'yahoo.com.mx',
      'yahoo.es', 'yahoo.it', 'yahoo.ca', 'ymail.com', 'rocketmail.com',
    ],
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
    // Telekom Login password. The link is Telekom's article on that password;
    // it sits behind a bot check for scripts but opens for people.
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
    appPasswordHelpUrl: TELEKOM_MAIL_PASSWORD_HELP,
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
    // seznam.cz, email.cz and post.cz are the three domains Seznam offers
    // (blog.seznam.cz, 2017); imap.email.cz and imap.post.cz answer with the
    // same banner, but Seznam documents only the seznam.cz names.
    domains: ['seznam.cz', 'email.cz', 'post.cz'],
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
  // ── Brazil (research 2026-11-04). Hosts were probed live (TLS handshake with
  // a verified chain) and, where production has inboxes there, match the
  // settings those inboxes connected with.
  {
    // Locaweb, the largest .br host. Every Locaweb mailbox uses the shared
    // email-ssl.com.br name (certificate *.email-ssl.com.br); the customer's
    // pop.<domain> is a CNAME to mail.ita.locaweb.com.br. The MX names are
    // listed exactly, not as .locaweb.com.br, because Locaweb also runs mail
    // for other brands under that zone (mx1.r7.email.locaweb.com.br) whose
    // users do not sign in at email-ssl.com.br.
    id: 'locaweb',
    label: 'Locaweb',
    hostSuffixes: ['email-ssl.com.br', '.email-ssl.com.br', 'mail.ita.locaweb.com.br'],
    mxSuffixes: ['mx.core.locaweb.com.br', 'mx.a.locaweb.com.br', 'mx.b.locaweb.com.br', 'mx.jk.locaweb.com.br'],
    imapHost: 'email-ssl.com.br',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'email-ssl.com.br',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // KingHost (Locaweb group). Sending is smtpi.kinghost.net: smtp.kinghost.net
    // did not answer on 465 or 587 from outside KingHost's network. Exact
    // hosts only, because the MX customers publish was not verified.
    id: 'kinghost',
    label: 'KingHost',
    hostSuffixes: ['imap.kinghost.net', 'smtpi.kinghost.net'],
    imapHost: 'imap.kinghost.net',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtpi.kinghost.net',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // UOL Mail. The registry and the ISPDB agree on 587/STARTTLS for sending.
    // IMAP has to be switched on in webmail (Ativar IMAP) first.
    id: 'uol',
    label: 'UOL Mail',
    domains: ['uol.com.br'],
    hostSuffixes: ['imap.uol.com.br', 'smtps.uol.com.br'],
    imapHost: 'imap.uol.com.br',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtps.uol.com.br',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    // BOL, UOL's free service, on the same platform.
    id: 'bol',
    label: 'BOL',
    domains: ['bol.com.br'],
    hostSuffixes: ['imap.bol.com.br', 'smtps.bol.com.br'],
    imapHost: 'imap.bol.com.br',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtps.bol.com.br',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'terra',
    label: 'Terra',
    domains: ['terra.com.br'],
    hostSuffixes: ['imap.terra.com.br', 'smtp.terra.com.br'],
    imapHost: 'imap.terra.com.br',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.terra.com.br',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  // ── Japan (research 2026-11-04). Each host was probed live, and each
  // provider's own help page documents it. None of these is in the ISPDB with
  // IMAP, so without an entry here autodiscover finds nothing for them.
  {
    // Yahoo! JAPAN, not Yahoo: a different company and platform. There are no
    // app passwords; the ordinary Yahoo! JAPAN ID password works once IMAP and
    // SMTP access are switched on (support.yahoo-net.jp H000007321). The MX
    // names (mx*.mail.yahoo.co.jp) sit under the host suffix too.
    id: 'yahoo-jp',
    label: 'Yahoo! JAPAN',
    domains: ['yahoo.co.jp', 'ymail.ne.jp'],
    hostSuffixes: ['.mail.yahoo.co.jp'],
    imapHost: 'imap.mail.yahoo.co.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.mail.yahoo.co.jp',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // docomo mail. The login is the IMAP-only ID and password shown in My
    // docomo, not the address. The servers do not support secure
    // renegotiation, see email/legacy-tls.ts.
    id: 'docomo',
    label: 'docomo mail',
    domains: ['docomo.ne.jp'],
    hostSuffixes: ['imap.spmode.ne.jp', 'imap2.spmode.ne.jp', 'smtp.spmode.ne.jp'],
    imapHost: 'imap.spmode.ne.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.spmode.ne.jp',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // SoftBank Eメール(i). softbank.ne.jp is MMS on a different service.
    id: 'softbank',
    label: 'SoftBank',
    domains: ['i.softbank.jp'],
    hostSuffixes: ['imap.softbank.jp', 'smtp.softbank.jp'],
    imapHost: 'imap.softbank.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.softbank.jp',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // OCN: the mail password, not the OCN ID password.
    id: 'ocn',
    label: 'OCN',
    domains: ['ocn.ne.jp'],
    hostSuffixes: ['imap.ocn.ne.jp', 'smtp.ocn.ne.jp'],
    imapHost: 'imap.ocn.ne.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.ocn.ne.jp',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // BIGLOBE: one host for both halves; the BIGLOBE password, not the
    // connection password.
    id: 'biglobe',
    label: 'BIGLOBE',
    domains: ['biglobe.ne.jp'],
    hostSuffixes: ['mail.biglobe.ne.jp'],
    imapHost: 'mail.biglobe.ne.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.biglobe.ne.jp',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // @nifty: mail-app access over IMAP must be set to allowed (許可中) first.
    // The ISPDB's entry is plaintext POP on 110 and out of date.
    id: 'nifty',
    label: '@nifty',
    domains: ['nifty.com'],
    hostSuffixes: ['imap.nifty.com', 'smtp.nifty.com'],
    imapHost: 'imap.nifty.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.nifty.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // So-net: IMAP is a paid option, and sending is mail.so-net.ne.jp on
    // 587/STARTTLS.
    id: 'so-net',
    label: 'So-net',
    domains: ['so-net.ne.jp'],
    hostSuffixes: ['imap.so-net.ne.jp', 'mail.so-net.ne.jp'],
    imapHost: 'imap.so-net.ne.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.so-net.ne.jp',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    // plala: IMAP has to be turned on in plala Webmail first.
    id: 'plala',
    label: 'plala',
    domains: ['plala.or.jp'],
    hostSuffixes: ['imap.plala.or.jp', 'secure.plala.or.jp'],
    imapHost: 'imap.plala.or.jp',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'secure.plala.or.jp',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  // ── Germany, Austria, Switzerland (research 2026-11-04). Probed live; the
  // production column is how many connected inboxes already use the host.
  {
    // STRATO, the largest DACH host in production (47 inboxes). Custom
    // domains publish an rzone.de MX. imap.strato.com is a name people type;
    // it serves the same certificate and mailboxes.
    id: 'strato',
    label: 'STRATO',
    domains: ['strato.de'],
    hostSuffixes: ['imap.strato.de', 'smtp.strato.de', 'imap.strato.com'],
    mxSuffixes: ['.rzone.de'],
    imapHost: 'imap.strato.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.strato.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Hetzner (konsoleH). One mail host for every customer; MX names are
    // wwwNNN.your-server.de / mx*.your-server.de.
    id: 'hetzner',
    label: 'Hetzner',
    hostSuffixes: ['mail.your-server.de', '.your-server.de'],
    imapHost: 'mail.your-server.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.your-server.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // freenet: POP3, IMAP and SMTP must be activated in freenet Mail first.
    // 465 is what the registry and /connect/freenet document; 587 also works.
    id: 'freenet',
    label: 'freenet',
    domains: ['freenet.de'],
    hostSuffixes: ['mx.freenet.de'],
    imapHost: 'mx.freenet.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mx.freenet.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Vodafone mail, including the Arcor and Kabel Deutschland addresses. The
    // e-mail password is separate from the MeinVodafone login.
    id: 'vodafone',
    label: 'Vodafone',
    domains: ['vodafone.de', 'arcor.de', 'vodafonemail.de', 'kabelmail.de', 'kabelbw.de'],
    hostSuffixes: ['.vodafonemail.de'],
    imapHost: 'imap.vodafonemail.de',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.vodafonemail.de',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // A1 (Austria), including the old aon.at addresses. Sending is 587
    // STARTTLS only: 465 is refused.
    id: 'a1',
    label: 'A1',
    domains: ['a1.net', 'aon.at'],
    hostSuffixes: ['securemail.a1.net'],
    imapHost: 'securemail.a1.net',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'securemail.a1.net',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    // Bluewin (Swisscom). MX mx0N.p.bluenet.ch.
    id: 'bluewin',
    label: 'Bluewin',
    domains: ['bluewin.ch'],
    hostSuffixes: ['imaps.bluewin.ch', 'smtpauths.bluewin.ch'],
    mxSuffixes: ['.p.bluenet.ch'],
    imapHost: 'imaps.bluewin.ch',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtpauths.bluewin.ch',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Hostpoint (Switzerland). Sending is asmtp.mail.hostpoint.ch; the MX
    // mx.mail.hostpoint.ch sits under the same suffix.
    id: 'hostpoint',
    label: 'Hostpoint',
    hostSuffixes: ['.mail.hostpoint.ch'],
    imapHost: 'imap.mail.hostpoint.ch',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'asmtp.mail.hostpoint.ch',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // cyon (Switzerland). MX mx01.cyon.ch.
    id: 'cyon',
    label: 'cyon',
    hostSuffixes: ['mail.cyon.ch', '.cyon.ch'],
    imapHost: 'mail.cyon.ch',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.cyon.ch',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // World4You (Austria). Sending is 587 STARTTLS: 465 is refused, which is
    // likely why this host has more failures than connected inboxes.
    id: 'world4you',
    label: 'World4You',
    hostSuffixes: ['imap.world4you.com', 'smtp.world4you.com'],
    imapHost: 'imap.world4you.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.world4you.com',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  // ── Italy (research 2026-11-10). Settings from each provider's own help
  // page; every host below completed a TLS handshake with a verified chain
  // and answered CAPABILITY or EHLO, except where the comment says otherwise.
  {
    // Aruba domain mailboxes (nome@tuodominio.ext): guide.aruba.it lists
    // imaps/smtps.aruba.it with SSL and authentication always required. The
    // address is always a custom domain, so the host is the key; Aruba's MX
    // names for hosted domains were not verified, so none are listed.
    id: 'aruba',
    label: 'Aruba',
    hostSuffixes: ['imaps.aruba.it', 'smtps.aruba.it', 'pop3s.aruba.it'],
    imapHost: 'imaps.aruba.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtps.aruba.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Aruba's free @aruba.it mailboxes document the names without the s.
    id: 'aruba-free',
    label: 'Aruba',
    domains: ['aruba.it'],
    hostSuffixes: ['imap.aruba.it', 'smtp.aruba.it', 'pop3.aruba.it'],
    imapHost: 'imap.aruba.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.aruba.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Libero Mail (Italiaonline): aiuto.libero.it names libero.it, iol.it,
    // blu.it and inwind.it as the domains on these hosts. With Password
    // Sicura on, a 16-character app password; the account password is not
    // refused otherwise, so no flag.
    id: 'libero',
    label: 'Libero Mail',
    domains: ['libero.it', 'iol.it', 'blu.it', 'inwind.it'],
    hostSuffixes: ['imapmail.libero.it', 'smtp.libero.it', 'popmail.libero.it'],
    imapHost: 'imapmail.libero.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.libero.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Virgilio Mail, same company, its own names (aiuto.virgilio.it).
    id: 'virgilio',
    label: 'Virgilio Mail',
    domains: ['virgilio.it'],
    hostSuffixes: ['in.virgilio.it', 'out.virgilio.it'],
    imapHost: 'in.virgilio.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'out.virgilio.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // TIM Mail documents 143 and 587 with STARTTLS only (tim.it assistenza,
    // protocolli-posta); 993 and 465 time out. Each domain has its own hosts.
    // Mail apps are allowed on a mailbox tied to an active TIM line, or from
    // TIM's own network; see the tim fix row.
    id: 'tim',
    label: 'TIM Mail',
    domains: ['tim.it'],
    hostSuffixes: ['imap.tim.it', 'smtp.tim.it', 'pop.tim.it'],
    imapHost: 'imap.tim.it',
    imapPort: 143,
    imapSecurity: 'starttls',
    smtpHost: 'smtp.tim.it',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    id: 'tim-alice',
    label: 'TIM Mail',
    domains: ['alice.it'],
    hostSuffixes: ['in.alice.it', 'out.alice.it'],
    imapHost: 'in.alice.it',
    imapPort: 143,
    imapSecurity: 'starttls',
    smtpHost: 'out.alice.it',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    // The s in imaps/smtps.tin.it does not mean implicit TLS: TIM lists the
    // same 143/587 STARTTLS ports for tin.it.
    id: 'tim-tin',
    label: 'TIM Mail',
    domains: ['tin.it'],
    hostSuffixes: ['imaps.tin.it', 'smtps.tin.it', 'pops.tin.it'],
    imapHost: 'imaps.tin.it',
    imapPort: 143,
    imapSecurity: 'starttls',
    smtpHost: 'smtps.tin.it',
    smtpPort: 587,
    smtpSecurity: 'starttls',
  },
  {
    // Tiscali: IMAP on 993 answers. smtp.tiscali.it:465 is the documented
    // sending host, but from outside Tiscali's network it greets with "554
    // ESMTP server not available from your IP" (and offers only a 1024-bit DH
    // key), so the connect form ends up offering reading only. The settings
    // are still the ones Tiscali documents, which is what the lookup shows.
    id: 'tiscali',
    label: 'Tiscali Mail',
    domains: ['tiscali.it'],
    hostSuffixes: ['imap.tiscali.it', 'smtp.tiscali.it', 'pop.tiscali.it'],
    imapHost: 'imap.tiscali.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.tiscali.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  // ── PEC, Italian certified email. All three providers serve ordinary
  // IMAP/SMTP; the password rule differs, see the pec content and fix rows.
  {
    // Aruba PEC: @pec.it and pec.<domain> mailboxes. The MX for pec.it is
    // mx.pec.aruba.it, under the same suffix, so a custom PEC domain is found
    // through its MX. With verifica in 2 passaggi on, a six-month password for
    // mail programs; the mailbox password works otherwise, so no flag.
    id: 'aruba-pec',
    label: 'Aruba PEC',
    domains: ['pec.it'],
    hostSuffixes: ['.pec.aruba.it'],
    imapHost: 'imaps.pec.aruba.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtps.pec.aruba.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Legalmail (InfoCert): operating manual, mbox and sendm under
    // cert.legalmail.it, which also covers the mx.cert.legalmail.it MX. The
    // login is the User ID and mailbox password, or an optional Application
    // Password; nothing is refused by default, so no flag.
    id: 'legalmail',
    label: 'Legalmail',
    domains: ['legalmail.it'],
    hostSuffixes: ['.cert.legalmail.it'],
    imapHost: 'mbox.cert.legalmail.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'sendm.cert.legalmail.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Poste Italiane Postecert: the webmail password (Account Poste
    // Verificato) never works in a client; a client password is generated in
    // the PEC dashboard and expires every 90 days (poste.it PEC FAQ).
    id: 'postecert',
    label: 'Poste PEC',
    domains: ['postecert.it'],
    hostSuffixes: ['.postecert.it'],
    imapHost: 'mail.postecert.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.postecert.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://www.poste.it/assistenza/faq-posta-elettronica-certificata',
  },
  {
    // PEC postecertifica, Poste's current product, same rule.
    id: 'postecertifica',
    label: 'Poste PEC',
    domains: ['postecertifica.it'],
    hostSuffixes: ['.postecertifica.it'],
    imapHost: 'mail.postecertifica.it',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.postecertifica.it',
    smtpPort: 465,
    smtpSecurity: 'tls',
    requiresAppPassword: true,
    appPasswordHelpUrl: 'https://www.poste.it/assistenza/faq-posta-elettronica-certificata',
  },
  // ── Czechia and Poland (research 2026-11-10). The Polish portals and
  // Seznam were already in the registry; these entries give the connect form
  // and a typed host the same answer the /connect page prints.
  {
    // Centrum.cz (Economia): freemail.help.economia.cz lists the centrum.cz
    // settings for cbox.cz, mujmail.cz "and other" domains too. SMTP needs the
    // free enlarged mailbox first; with two-factor on, an aplikační heslo.
    id: 'centrum',
    label: 'Centrum.cz',
    domains: ['centrum.cz', 'cbox.cz', 'mujmail.cz'],
    hostSuffixes: ['imap.centrum.cz', 'smtp.centrum.cz', 'pop3.centrum.cz'],
    imapHost: 'imap.centrum.cz',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.centrum.cz',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Atlas.cz: its own IMAP name, Centrum's SMTP.
    id: 'atlas',
    label: 'Atlas.cz',
    domains: ['atlas.cz'],
    hostSuffixes: ['imap.atlas.cz', 'pop3.atlas.cz'],
    imapHost: 'imap.atlas.cz',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.centrum.cz',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    id: 'volny',
    label: 'Volný.cz',
    domains: ['volny.cz'],
    hostSuffixes: ['imap.volny.cz', 'smtp.volny.cz', 'pop3.volny.cz'],
    imapHost: 'imap.volny.cz',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.volny.cz',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // WP Poczta: IMAP has to be switched on under Opcje > IMAP/POP; with
    // two-step login, a mail-program password (pomoc.wp.pl).
    id: 'wp',
    label: 'WP Poczta',
    domains: ['wp.pl'],
    hostSuffixes: ['imap.wp.pl', 'smtp.wp.pl', 'pop3.wp.pl'],
    imapHost: 'imap.wp.pl',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.wp.pl',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // o2.pl (same group as WP): one name for both halves (pomoc.o2.pl).
    id: 'o2-pl',
    label: 'o2.pl',
    domains: ['o2.pl'],
    hostSuffixes: ['poczta.o2.pl'],
    imapHost: 'poczta.o2.pl',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'poczta.o2.pl',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Onet Poczta: each protocol has its own switch under Konto Główne; with
    // two-step verification, a hasło do aplikacji (pomoc.poczta.onet.pl).
    id: 'onet',
    label: 'Onet Poczta',
    domains: ['onet.pl', 'op.pl', 'poczta.onet.pl'],
    hostSuffixes: ['.poczta.onet.pl'],
    imapHost: 'imap.poczta.onet.pl',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.poczta.onet.pl',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Interia: one host for both halves; the domain list is the one on
    // pomoc.poczta.interia.pl's parameters page. Mail programs must be
    // enabled (korzystam z programu pocztowego: TAK) and are blocked while
    // two-step login is on.
    id: 'interia',
    label: 'Interia',
    domains: ['interia.pl', 'interia.eu', 'poczta.fm', 'intmail.pl', 'interia.com', 'vip.interia.pl', 'interiowy.pl', 'adresik.net', 'pacz.to', 'pisz.to', 'ogarnij.se'],
    hostSuffixes: ['poczta.interia.pl'],
    imapHost: 'poczta.interia.pl',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'poczta.interia.pl',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Gazeta.pl Poczta (pomoc.gazeta.pl): the IMAP banner is Onet's, the
    // login is a Gazeta.pl account.
    id: 'gazeta-pl',
    label: 'Gazeta.pl Poczta',
    domains: ['gazeta.pl'],
    hostSuffixes: ['imap.gazeta.pl', 'smtp.gazeta.pl'],
    imapHost: 'imap.gazeta.pl',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.gazeta.pl',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  // ── Web hosts our users connect (research 2026-11-11). Settings from each
  // vendor's own help page; every host below completed a TLS handshake with a
  // verified chain and answered CAPABILITY and EHLO.
  {
    // cyber_Folks (Poland): no shared host. Each account lives on an
    // sNN.cyber-folks.pl server named in cyber_Admin under Dane
    // konfiguracyjne, all under one *.cyber-folks.pl certificate. The typed
    // host is the customer's own server and must be kept (settings-lookup
    // lists this id in CLUSTER_PRESETS); s1 is only a generic fallback.
    id: 'cyber-folks',
    label: 'cyber_Folks',
    hostSuffixes: ['.cyber-folks.pl'],
    imapHost: 's1.cyber-folks.pl',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 's1.cyber-folks.pl',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // TransIP email hosting (transip.eu knowledgebase 309). Its cPanel and
    // DirectAdmin packages have their own server names and are not this.
    id: 'transip',
    label: 'TransIP',
    hostSuffixes: ['.transip.email'],
    imapHost: 'imap.transip.email',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.transip.email',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Combell Basic mailboxes (combell.com help): the mailprotect.be platform,
    // with autodiscover SRV records pointing at the same names. Exchange and
    // Microsoft 365 mailboxes at Combell do not use these hosts.
    id: 'combell',
    label: 'Combell',
    hostSuffixes: ['.mailprotect.be'],
    imapHost: 'imap.mailprotect.be',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp-auth.mailprotect.be',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Websupport (Slovakia): the KB names imap/smtp.m1.websupport.sk; WebAdmin
    // shows each mailbox's own names under Prihlasovacie udaje, which sit
    // under the same suffix. GEO ochrana allows SK/CZ/HU/AT logins by default,
    // so a refused password here is usually the country list, not the password.
    id: 'websupport',
    label: 'Websupport',
    hostSuffixes: ['.websupport.sk'],
    imapHost: 'imap.m1.websupport.sk',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.m1.websupport.sk',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Websupport.cz documents imap/smtp.websupport.cz (iOS guide); same
    // Dovecot and ingress as the Slovak platform, own certificate.
    id: 'websupport-cz',
    label: 'Websupport',
    hostSuffixes: ['.websupport.cz'],
    imapHost: 'imap.websupport.cz',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.websupport.cz',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // REG.RU shared hosting (help.reg.ru): mail.hosting.reg.ru both ways on
    // an encrypted connection. The Yandex 360 and Mail.ru products REG.RU
    // resells use those providers' hosts and are matched by them.
    id: 'reg-ru',
    label: 'REG.RU',
    hostSuffixes: ['.hosting.reg.ru'],
    imapHost: 'mail.hosting.reg.ru',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'mail.hosting.reg.ru',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // 20i's StackMail platform (docs.20i.com), also behind every 20i
    // reseller's white-labelled mail. Autodiscover points at the same names.
    id: 'stackmail',
    label: '20i StackMail',
    domains: ['stackmail.com'],
    hostSuffixes: ['.stackmail.com'],
    imapHost: 'imap.stackmail.com',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.stackmail.com',
    smtpPort: 465,
    smtpSecurity: 'tls',
  },
  {
    // Arsys (Spain) runs mailboxes on serviciodecorreo.es, the names its
    // support centre lists; mail.arsys.es from an old blog post refused 993.
    id: 'arsys',
    label: 'Arsys',
    hostSuffixes: ['.serviciodecorreo.es'],
    imapHost: 'imap.serviciodecorreo.es',
    imapPort: 993,
    imapSecurity: 'tls',
    smtpHost: 'smtp.serviciodecorreo.es',
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

/** The error code the Yahoo card answers with for a Yahoo! JAPAN address. */
export const YAHOO_JAPAN_USE_GENERIC = 'yahoo_japan_use_generic';

/**
 * True for an address on Yahoo! JAPAN (@yahoo.co.jp, @ymail.ne.jp).
 *
 * The Yahoo card connects to imap.mail.yahoo.com with a Yahoo app password.
 * Yahoo! JAPAN is a separate company on separate servers and has no app
 * passwords, so that card can never connect one of its addresses: it would
 * send a Yahoo! JAPAN password to Yahoo's US servers. The route refuses the
 * attempt and the modal points at the generic form, where the 'yahoo-jp'
 * preset fills in the right servers.
 */
export function isYahooJapanAddress(email: string | null | undefined): boolean {
  const domain = emailDomain(String(email ?? ''));
  return MAIL_HOST_PRESETS.find((preset) => preset.id === 'yahoo-jp')?.domains?.includes(domain) === true;
}

export function prefillFromEmail(email: string): MailHostPrefill | null {
  const preset = findMailHostPreset({ email });
  return preset ? prefillFromPreset(preset) : null;
}
