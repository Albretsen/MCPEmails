// Browser-safe: the connect modal calls this on render. Nothing here may reach
// for a node builtin, and the only runtime import is the host-preset table the
// modal already bundles.
import { emailDomain, findMailHostPreset, prefillFromDomain } from '@/lib/email-providers/host-presets';
import type { AuthFailureReason } from '@/lib/email/auth-failure';

/**
 * What to tell someone whose mail server just refused their login.
 *
 * `auth-failure.ts` decides WHICH rejection it was. This module decides what
 * the person reads next, and it exists because of one number: since 2026-09-10,
 * 40 of the 98 business-domain workspaces that tried the generic IMAP form got
 * `password_rejected` (172 failures, about four retries each) and 8 of them
 * never connected. Those are own-domain mailboxes at shared hosts, and they are
 * real wrong-credential cases: the hosting-account login typed where the
 * mailbox password belongs, a short username where the host wants the whole
 * address, or a mailbox whose host needs an app password. "The mail server
 * rejected that password" is true of all three and fixes none of them.
 *
 * So a rejected password on a host we recognise now says which password that
 * host expects, what the username must be, and where in the host's own control
 * panel the mailbox password is set. A host we do not recognise gets the same
 * three answers in their general own-domain form.
 *
 * EVERY HOST FACT BELOW IS COPIED FROM THE REPO'S VERIFIED PROVIDER CONTENT,
 * `src/lib/connect/content/en/<slug>.json` (checked against vendor docs and
 * live probes), and each entry names its source. Nothing here is from memory.
 * Where that content does not say where a password is set, the entry says no
 * more than the content does. The mail hostnames are checked against
 * `src/lib/connect/providers.mjs` by the unit test, so a host that moves in the
 * registry fails here rather than silently losing its hint.
 *
 * The function returns message KEYS and plain values, never sentences: the
 * modal renders exactly what comes back, in the user's language. It is handed
 * the address, the mail host and the typed username and nothing else. The
 * password is not an input, so it cannot be echoed, and neither can anything
 * the server said.
 */

/** One sentence to render: a `dashboardChrome` key and its values. */
export interface AuthHelpLine {
  key: string;
  values?: Record<string, string>;
}

export interface AuthFailureHelp {
  /** Which host table entry answered, or null for the general guidance. */
  hostId: string | null;
  lines: AuthHelpLine[];
  /**
   * True when a line points at the Username field. That field lives in a
   * section the generic form can collapse, so the modal opens the section
   * rather than describing a control that is not on screen.
   */
  showsUsernameField: boolean;
}

interface HostHelp {
  id: string;
  /** The host's public name, substituted into the shared sentences. */
  label: string;
  /** Slug(s) of the verified content the facts were taken from. */
  sources: readonly string[];
  /** `MAIL_HOST_PRESETS` ids that identify this host. */
  presetIds?: readonly string[];
  /** Mail hostnames: an exact host, or a suffix when it starts with a dot. */
  hostSuffixes?: readonly string[];
  /**
   * False for the one host where "the mailbox's own password, not your account
   * login" is not the story (see Titan).
   */
  mailboxPasswordLine?: boolean;
  /** Where the mailbox password is set, as the content states it. */
  whereKey: string;
  /** Further host-specific sentences, in order. */
  extraKeys?: readonly string[];
}

/**
 * Scanned in order; the first match wins.
 *
 * `sources` is the audit trail. To change a sentence, change it in the content
 * file first and here second.
 */
export const HOST_HELP: readonly HostHelp[] = [
  {
    // ionos.json, setup[1]: "In the IONOS control panel, open Email, pick the
    // address and set or reset its password. It is not the password you use to
    // sign in to IONOS itself." auth.usernameForm: the full email address.
    id: 'ionos',
    label: 'IONOS',
    sources: ['ionos'],
    presetIds: ['ionos', 'ionos-de', 'ionos-uk', 'ionos-fr', 'ionos-es', 'ionos-it'],
    hostSuffixes: ['imap.ionos.com', 'smtp.ionos.com'],
    whereKey: 'connect.authHelpWhereIonos',
  },
  {
    // strato.json, setup[1]: "Sign in to the STRATO Kundenlogin, open your
    // package, and go to E-Mail, then E-Mail-Adressen verwalten. Select the
    // address and set a new password there." The menu names are STRATO's own
    // German labels and are kept in German in every locale.
    id: 'strato',
    label: 'STRATO',
    sources: ['strato'],
    hostSuffixes: ['imap.strato.de', 'smtp.strato.de'],
    whereKey: 'connect.authHelpWhereStrato',
  },
  {
    // one-com.json, setup[1]: "Log in to the one.com Control Panel and open the
    // Email tile. ... Click the address to edit it and set a password".
    // method.body: the password "is separate from the login you use for the
    // one.com Control Panel itself".
    id: 'one-com',
    label: 'one.com',
    sources: ['one-com'],
    hostSuffixes: ['imap.one.com', 'send.one.com'],
    whereKey: 'connect.authHelpWhereOneCom',
  },
  {
    // ovh.json, setup[1]: "In the OVH control panel, open the email service,
    // pick the address and change its password." auth.usernameForm: the full
    // address "on every one of its mail products", which is why Hosted
    // Exchange shares the entry.
    id: 'ovh',
    label: 'OVH',
    sources: ['ovh'],
    presetIds: ['ovh', 'ovh-exchange'],
    hostSuffixes: ['ssl0.ovh.net'],
    whereKey: 'connect.authHelpWhereOvh',
  },
  {
    // hostinger.json, setup[1]: "In hPanel, open Emails, pick the address and
    // set or reset its password." gotchas[0]: the password is the mailbox
    // password "or an app password if the mailbox uses two-factor
    // authentication".
    id: 'hostinger',
    label: 'Hostinger',
    sources: ['hostinger'],
    presetIds: ['hostinger'],
    hostSuffixes: ['imap.hostinger.com', 'smtp.hostinger.com'],
    whereKey: 'connect.authHelpWhereHostinger',
    extraKeys: ['connect.authHelpTwoFactor'],
  },
  {
    // namecheap.json, setup[1]: "Use the password for the mailbox itself, not
    // your Namecheap account password. You can reset it from the Private Email
    // control panel". gotchas[1]: with 2FA on, an application-specific
    // password from webmail "Settings, then Security, then Application
    // Passwords".
    id: 'namecheap',
    label: 'Namecheap',
    sources: ['namecheap'],
    presetIds: ['privateemail'],
    hostSuffixes: ['mail.privateemail.com'],
    whereKey: 'connect.authHelpWhereNamecheap',
    extraKeys: ['connect.authHelpTwoFactorNamecheap'],
  },
  {
    // siteground.json, method.body: the secure server name has the shape
    // secureNNN.sgcpanel.com, and the settings live at "Site Tools, then Email,
    // then Accounts". setup[2]: "Set the mailbox password from the same
    // Accounts screen ...; it is not your Client Area password."
    id: 'siteground',
    label: 'SiteGround',
    sources: ['siteground'],
    hostSuffixes: ['.sgcpanel.com'],
    whereKey: 'connect.authHelpWhereSiteground',
  },
  {
    // hostgator.json, method.body: TLS mail uses the server's own name,
    // gator1234.hostgator.com or servername.websitewelcome.com. setup[2]: "In
    // cPanel, open Email Accounts and click Manage next to the address to set
    // one." auth.usernameForm: the full address, "Not your cPanel username."
    id: 'hostgator',
    label: 'HostGator',
    sources: ['hostgator', 'cpanel'],
    hostSuffixes: ['.hostgator.com', '.websitewelcome.com'],
    whereKey: 'connect.authHelpWhereCpanel',
  },
  {
    // inmotion.json, setup[2]: "IMAP checks the password on the individual
    // address, not your AMP login. In cPanel open Email Accounts, click Manage
    // on the address, and set a password. ... secureNN.inmotionhosting.com as
    // the host." The `uhserver` preset is the same company's older hostname.
    id: 'inmotion',
    label: 'InMotion Hosting',
    sources: ['inmotion', 'cpanel'],
    presetIds: ['uhserver'],
    hostSuffixes: ['.inmotionhosting.com'],
    whereKey: 'connect.authHelpWhereCpanel',
  },
  {
    // titan.json, gotchas[0]: "A Titan mailbox ships with third-party access
    // disabled ... IMAP, POP and SMTP all fail at the login step with an error
    // that looks exactly like a wrong password ... The switch is in Titan
    // webmail under Settings, then Enable Titan on Other Apps." gotchas[2]:
    // application passwords exist for mailboxes with 2FA.
    //
    // No "not your account login" line: on Titan the usual cause is the
    // switch, not the wrong one of two passwords.
    id: 'titan',
    label: 'Titan',
    sources: ['titan'],
    presetIds: ['titan'],
    hostSuffixes: ['imap.titan.email', 'smtp.titan.email'],
    mailboxPasswordLine: false,
    whereKey: 'connect.authHelpTitanSwitch',
    extraKeys: ['connect.authHelpTwoFactor'],
  },
];

/**
 * The next step for each classified rejection other than a plain wrong
 * password. Moved here from ConnectModal so the whole reason-to-copy mapping
 * is in one tested place.
 */
const REASON_DETAIL_KEYS: Partial<Record<AuthFailureReason, string>> = {
  imap_disabled: 'connect.imapDisabledDetail',
  app_password_required: 'connect.appPasswordRequiredDetail',
  account_password_used: 'connect.appPasswordAccountDetail',
  app_password_length: 'connect.appPasswordLengthDetail',
  provider_refused_signin: 'connect.providerRefusedDetail',
};

function normalizeHost(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function matchesSuffix(host: string, suffixes: readonly string[] | undefined): boolean {
  if (!host || !suffixes) return false;
  return suffixes.some((suffix) => (suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix));
}

/**
 * The host-help entry for a mailbox, from the mail hosts the attempt used and
 * the address.
 *
 * A mail host is believed before the address: on a custom domain the address
 * says nothing about where the mail lives, while the hostname IS the server
 * that refused the login.
 */
export function findHostHelp(input: {
  email?: string | null;
  host?: string | null;
  smtpHost?: string | null;
}): HostHelp | null {
  const hosts = [normalizeHost(input.host), normalizeHost(input.smtpHost)].filter(Boolean);
  for (const host of hosts) {
    const direct = HOST_HELP.find((entry) => matchesSuffix(host, entry.hostSuffixes));
    if (direct) return direct;
  }
  // The preset table knows more spellings of the same hosts (regional IONOS
  // names, OVH's numbered clusters) and how to read an address on a provider's
  // own domain.
  for (const host of hosts.length > 0 ? hosts : ['']) {
    const preset = findMailHostPreset({ email: input.email, host });
    if (preset) return HOST_HELP.find((entry) => entry.presetIds?.includes(preset.id)) ?? null;
  }
  return null;
}

export interface AuthFailureHelpInput {
  /** The classified reason from the connect route, or null when there is none. */
  reason: AuthFailureReason | string | null | undefined;
  email?: string | null;
  /** The IMAP host the attempt used (generic form only). */
  host?: string | null;
  smtpHost?: string | null;
  /** The separate login name the user typed, when they typed one. */
  username?: string | null;
  /**
   * True on the generic IMAP form, the only one with a Username field. On a
   * branded provider card there is no such field and no Advanced section, so
   * no line may send the user looking for either.
   */
  generic: boolean;
  /** Provider name for the app-password sentences that carry one. */
  providerLabel?: string | null;
}

const NO_HELP: AuthFailureHelp = { hostId: null, lines: [], showsUsernameField: false };

/** What to render under a rejected login. Pure. */
export function authFailureHelp(input: AuthFailureHelpInput): AuthFailureHelp {
  const reason = input.reason;
  if (!reason) return NO_HELP;

  if (reason === 'login_username_required') {
    // The generic form has the field, inside Advanced settings, and the modal
    // opens that section for this reason. A branded card has neither, so it is
    // sent to the form that does instead of to a section it cannot find.
    return input.generic
      ? { hostId: null, lines: [{ key: 'connect.loginNameDetail' }], showsUsernameField: true }
      : { hostId: null, lines: [{ key: 'connect.loginNameDetailBranded' }], showsUsernameField: false };
  }

  if (reason !== 'password_rejected') {
    const key = REASON_DETAIL_KEYS[reason as AuthFailureReason];
    if (!key) return NO_HELP;
    return {
      hostId: null,
      lines: [{ key, values: { provider: String(input.providerLabel ?? '') } }],
      showsUsernameField: false,
    };
  }

  // ── A plain rejected password ─────────────────────────────────────────────
  // Only the generic form reaches a host we can name: a branded card's
  // provider refuses account passwords outright and is classified as an
  // app-password case before it gets here.
  if (!input.generic) return NO_HELP;

  const email = String(input.email ?? '').trim().toLowerCase();
  const username = String(input.username ?? '').trim().toLowerCase();
  // A typed username that is just the address again is not a separate login.
  const separateUsername = Boolean(username) && username !== email;

  const entry = findHostHelp({ email: input.email, host: input.host, smtpHost: input.smtpHost });
  const lines: AuthHelpLine[] = [];

  if (entry) {
    const values = { host: entry.label };
    if (entry.mailboxPasswordLine !== false) lines.push({ key: 'connect.authHelpMailboxPassword', values });
    lines.push({ key: entry.whereKey });
    for (const key of entry.extraKeys ?? []) lines.push({ key });
    // Every host in the table documents the full address as the login.
    if (separateUsername) lines.push({ key: 'connect.authHelpUsernameHost', values });
    return { hostId: entry.id, lines, showsUsernameField: separateUsername };
  }

  // A provider the preset table recognises but this table has no verified
  // panel path for (GMX, mail.com, Migadu, ...). "Your hosting account" would
  // be the wrong story for a webmail address, so it gets only what is true of
  // any mailbox.
  const recognised = findMailHostPreset({ email: input.email, host: input.host });
  if (!recognised) {
    lines.push({ key: 'connect.authHelpOwnDomainPassword' });
    lines.push({ key: 'connect.authHelpOwnDomainWhere' });
  }
  lines.push({ key: 'connect.authHelpTwoFactor' });
  if (separateUsername) lines.push({ key: 'connect.authHelpUsernameTyped' });
  return { hostId: null, lines, showsUsernameField: separateUsername };
}

// ════════════════════════════════════════════════════════════════════════════
// The connect fix table
// ════════════════════════════════════════════════════════════════════════════
//
// One row per (provider, auth_reason, phase, host) class a failed connect can
// land in. The panel under a failed Connect renders exactly one row: the one
// thing to do for this provider and this failure, with the exact link, and a
// "Test again" that re-sends what is typed. People give up after two quick
// attempts, so a generic "check your settings" is what this replaces.
//
// Every URL and menu path below was checked against the provider's own help
// page on 2026-10-24, or is copied from the verified provider content in
// src/lib/connect/content/en/<slug>.json. Where a help page could not be
// fetched (Telekom puts its help articles behind a sign-in check) the link is
// the provider's help root rather than a guessed deep link.
//
// Like the rest of this module: keys and plain values only, never sentences,
// and nothing the mail server said. The password is never an input.

/** A link in a fix row. `id` is what `connect_fix_link_clicked` is about. */
export interface FixLink {
  id: string;
  labelKey: string;
  url: string;
  values?: Record<string, string>;
}

export type FixProviderId =
  | 'gmail'
  | 'yahoo'
  | 'aol'
  | 'icloud'
  | 'ionos'
  | 't_online'
  | 'mail_ru'
  | 'qq'
  | 'mail_com'
  | 'infomaniak'
  | 'orange'
  | 'seznam'
  | 'gmx'
  | 'web_de'
  | 'zoho'
  | 'yandex'
  | 'office365';

interface FixBlock {
  steps: readonly string[];
  links: readonly FixLink[];
}

export interface FixProvider {
  id: FixProviderId;
  label: string;
  /** `MAIL_HOST_PRESETS` ids (and modal card names) that identify this provider. */
  presetIds: readonly string[];
  /** A rejected credential: account password used, app password needed, or a toggle that looks like one. */
  credential?: FixBlock;
  /** `imap_disabled`. */
  imapDisabled?: FixBlock;
}

const GOOGLE_APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';
const GOOGLE_TWO_STEP = 'https://myaccount.google.com/signinoptions/two-step-verification';
const GOOGLE_WORKSPACE_IMAP = 'https://knowledge.workspace.google.com/admin/sync/turn-pop-and-imap-on-or-off-for-users';
const ORANGE_IMAP =
  'https://assistance.orange.fr/ordinateurs-peripheriques/installer-et-utiliser/l-utilisation-du-mail-et-du-cloud/mail-orange/le-mail-orange-nouvelle-version/parametrer-la-boite-mail/mail-orange-comment-activer-ou-desactiver-les-acces-pop-imap-pour-les-logiciels-ou-applications-de-messagerie-tiers_427398-957069';
const MAIL_RU_HELP = 'https://help.mail.ru/mail/login/mailer/';
const QQ_HELP = 'https://help.mail.qq.com/detail/106/985';
const MAIL_COM_IMAP = 'https://support.mail.com/pop-imap/index.html';
const ZOHO_IMAP = 'https://www.zoho.com/mail/help/imap-access.html';
const YANDEX_IMAP = 'https://yandex.com/support/yandex-360/customers/mail/en/mail-clients/others.html';

/**
 * Scanned in order. Where a provider is also in `MAIL_HOST_PRESETS` with an
 * `appPasswordHelpUrl`, its app-password link here is that same URL, and a
 * test holds the two together.
 */
export const CONNECT_FIX_PROVIDERS: readonly FixProvider[] = [
  {
    // support.google.com/accounts/answer/185833: app passwords need 2-Step
    // Verification, live at myaccount.google.com/apppasswords, are 16
    // characters, and a work or school account may not show the option.
    id: 'gmail',
    label: 'Google',
    presetIds: ['gmail'],
    credential: {
      steps: ['connect.fix.gmail.twoStep', 'connect.fix.gmail.create', 'connect.fix.gmail.paste', 'connect.fix.gmail.workspace'],
      links: [
        { id: 'gmail_two_step', labelKey: 'connect.fix.link.twoStep', url: GOOGLE_TWO_STEP },
        { id: 'gmail_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: GOOGLE_APP_PASSWORDS },
      ],
    },
    // knowledge.workspace.google.com "Turn POP and IMAP on or off for users":
    // Menu, Apps, Google Workspace, Gmail, End User Access.
    imapDisabled: {
      steps: ['connect.fix.gmail.imapDisabled', 'connect.fix.gmail.imapDisabledAdmin'],
      links: [{ id: 'gmail_workspace_imap', labelKey: 'connect.fix.link.adminGuide', url: GOOGLE_WORKSPACE_IMAP }],
    },
  },
  {
    // help.yahoo.com/kb/SLN15241: Account Security, External connections,
    // Create app password, name the app, generate.
    id: 'yahoo',
    label: 'Yahoo',
    presetIds: ['yahoo'],
    credential: {
      steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.yahoo.create', 'connect.fix.appPassword.paste'],
      links: [{ id: 'yahoo_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: 'https://login.yahoo.com/myaccount/security/app-password' }],
    },
  },
  {
    // aol.json setup: Account Security, 2-Step Verification, then generate an
    // app password. The generator answers on login.aol.com behind AOL's sign-in.
    id: 'aol',
    label: 'AOL',
    presetIds: ['aol'],
    credential: {
      steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.aol.create', 'connect.fix.appPassword.paste'],
      links: [{ id: 'aol_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: 'https://login.aol.com/myaccount/security/app-password' }],
    },
  },
  {
    // support.apple.com/en-us/102654: account.apple.com, Sign-In and
    // Security, App-Specific Passwords.
    id: 'icloud',
    label: 'Apple',
    presetIds: ['icloud'],
    credential: {
      steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.icloud.create', 'connect.fix.appPassword.paste'],
      links: [{ id: 'icloud_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: 'https://account.apple.com/account/manage' }],
    },
  },
  {
    // ionos.json: every address has its own email password, set in the
    // control panel under Email, and the login is the full address.
    id: 'ionos',
    label: 'IONOS',
    presetIds: ['ionos', 'ionos-de', 'ionos-uk', 'ionos-fr', 'ionos-es', 'ionos-it'],
    credential: {
      steps: ['connect.fix.ionos.password', 'connect.authHelpWhereIonos', 'connect.fix.fullAddress'],
      links: [{ id: 'ionos_help', labelKey: 'connect.fix.link.providerHelp', url: 'https://www.ionos.com/help/email/general-topics/ionos-mail-server-details-for-imap-pop3-and-smtp/' }],
    },
  },
  {
    // t-online.json: only the "Passwort für E-Mail-Programme" works.
    id: 't_online',
    label: 'Telekom',
    presetIds: ['t-online'],
    credential: {
      steps: ['connect.fix.tOnline.password', 'connect.fix.tOnline.where'],
      links: [{ id: 't_online_help', labelKey: 'connect.fix.link.providerHelp', url: 'https://www.telekom.de/hilfe' }],
    },
  },
  {
    // help.mail.ru/mail/login/mailer: Settings, All settings, Security,
    // Passwords for external applications, Create, full Mail access.
    id: 'mail_ru',
    label: 'Mail.ru',
    presetIds: ['mail-ru'],
    credential: {
      steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.mailRu.create', 'connect.fix.appPassword.paste'],
      links: [{ id: 'mail_ru_help', labelKey: 'connect.fix.link.providerHelp', url: MAIL_RU_HELP }],
    },
    imapDisabled: {
      steps: ['connect.fix.mailRu.create', 'connect.fix.appPassword.paste'],
      links: [{ id: 'mail_ru_help', labelKey: 'connect.fix.link.providerHelp', url: MAIL_RU_HELP }],
    },
  },
  {
    // help.mail.qq.com/detail/106/985: turn on the POP3/IMAP/SMTP service,
    // then generate the authorization code.
    id: 'qq',
    label: 'QQ Mail',
    presetIds: ['qq'],
    credential: {
      steps: ['connect.fix.qq.service', 'connect.fix.qq.code'],
      links: [{ id: 'qq_help', labelKey: 'connect.fix.link.providerHelp', url: QQ_HELP }],
    },
    imapDisabled: {
      steps: ['connect.fix.qq.service', 'connect.fix.qq.code'],
      links: [{ id: 'qq_help', labelKey: 'connect.fix.link.providerHelp', url: QQ_HELP }],
    },
  },
  {
    // mail-com.json: POP3 and IMAP is a Premium feature and starts switched
    // off; with two-factor on, an application-specific password.
    id: 'mail_com',
    label: 'mail.com',
    presetIds: ['mailcom'],
    credential: {
      steps: ['connect.fix.mailCom.imap', 'connect.fix.mailCom.twoFactor'],
      links: [
        { id: 'mail_com_imap', labelKey: 'connect.fix.link.imapSetting', url: MAIL_COM_IMAP },
        { id: 'mail_com_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: 'https://support.mail.com/security/2fa/application-specific-passwords.html' },
      ],
    },
    imapDisabled: {
      steps: ['connect.fix.mailCom.imap'],
      links: [{ id: 'mail_com_imap', labelKey: 'connect.fix.link.imapSetting', url: MAIL_COM_IMAP }],
    },
  },
  {
    // infomaniak.com/en/support/faq/1321: a device password per address.
    id: 'infomaniak',
    label: 'Infomaniak',
    presetIds: ['infomaniak'],
    credential: {
      steps: ['connect.fix.infomaniak.password', 'connect.fix.appPassword.paste'],
      links: [{ id: 'infomaniak_help', labelKey: 'connect.fix.link.providerHelp', url: 'https://www.infomaniak.com/en/support/faq/1321/add-a-device-create-a-mail-password-from-the-mail-service' }],
    },
  },
  {
    // orange-fr.json: POP/IMAP is off until switched on, then the
    // mot de passe dédié from the Espace client.
    id: 'orange',
    label: 'Orange',
    presetIds: ['orange'],
    credential: {
      steps: ['connect.fix.orange.imap', 'connect.fix.orange.password'],
      links: [{ id: 'orange_imap', labelKey: 'connect.fix.link.imapSetting', url: ORANGE_IMAP }],
    },
    imapDisabled: {
      steps: ['connect.fix.orange.imap'],
      links: [{ id: 'orange_imap', labelKey: 'connect.fix.link.imapSetting', url: ORANGE_IMAP }],
    },
  },
  {
    // seznam.json: IMAP is always on; with dvoufázové ověření an app password.
    id: 'seznam',
    label: 'Seznam',
    presetIds: ['seznam'],
    credential: {
      steps: ['connect.fix.seznam.password'],
      links: [{ id: 'seznam_help', labelKey: 'connect.fix.link.providerHelp', url: 'https://o-seznam.cz/napoveda/ucet/dvoufazove-overeni/postovni-programy/' }],
    },
  },
  {
    // gmx.json: POP3 and IMAP access is off by default.
    id: 'gmx',
    label: 'GMX',
    presetIds: ['gmx'],
    credential: {
      steps: ['connect.fix.gmx.imap', 'connect.fix.gmx.twoFactor'],
      links: [{ id: 'gmx_imap', labelKey: 'connect.fix.link.imapSetting', url: 'https://hilfe.gmx.net/pop-imap/einschalten.html' }],
    },
    imapDisabled: {
      steps: ['connect.fix.gmx.imap'],
      links: [{ id: 'gmx_imap', labelKey: 'connect.fix.link.imapSetting', url: 'https://hilfe.gmx.net/pop-imap/einschalten.html' }],
    },
  },
  {
    // web-de.json: the same switch as GMX.
    id: 'web_de',
    label: 'WEB.DE',
    presetIds: ['web-de'],
    credential: {
      steps: ['connect.fix.gmx.imap', 'connect.fix.gmx.twoFactor'],
      links: [{ id: 'web_de_imap', labelKey: 'connect.fix.link.imapSetting', url: 'https://hilfe.web.de/pop-imap/einschalten.html' }],
    },
    imapDisabled: {
      steps: ['connect.fix.gmx.imap'],
      links: [{ id: 'web_de_imap', labelKey: 'connect.fix.link.imapSetting', url: 'https://hilfe.web.de/pop-imap/einschalten.html' }],
    },
  },
  {
    // zoho.json: IMAP is off until turned on (Settings, Mail Accounts, IMAP
    // Access); with 2FA, SSO or SAML an application-specific password.
    id: 'zoho',
    label: 'Zoho',
    presetIds: ['zoho'],
    credential: {
      steps: ['connect.fix.zoho.imap', 'connect.fix.zoho.twoFactor'],
      links: [
        { id: 'zoho_imap', labelKey: 'connect.fix.link.imapSetting', url: ZOHO_IMAP },
        { id: 'zoho_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: 'https://accounts.zoho.com/home#security/device_pass' },
      ],
    },
    imapDisabled: {
      steps: ['connect.fix.zoho.imap'],
      links: [{ id: 'zoho_imap', labelKey: 'connect.fix.link.imapSetting', url: ZOHO_IMAP }],
    },
  },
  {
    // Yandex help, mail clients: Email clients, "From the imap.yandex.com
    // server via IMAP" and "App passwords and OAuth tokens"; the password
    // itself at id.yandex.com, Security, App passwords.
    id: 'yandex',
    label: 'Yandex',
    presetIds: ['yandex'],
    credential: {
      steps: ['connect.fix.appPassword.normalRejected', 'connect.fix.yandex.create', 'connect.fix.yandex.imap'],
      links: [
        { id: 'yandex_app_passwords', labelKey: 'connect.fix.link.appPasswords', url: 'https://id.yandex.com/security/app-passwords' },
        { id: 'yandex_imap', labelKey: 'connect.fix.link.imapSetting', url: YANDEX_IMAP },
      ],
    },
    imapDisabled: {
      steps: ['connect.fix.yandex.imap'],
      links: [{ id: 'yandex_imap', labelKey: 'connect.fix.link.imapSetting', url: YANDEX_IMAP }],
    },
  },
];

/** Microsoft 365 / Outlook hosts. Password sign-in is off there, so no password can work. */
const MICROSOFT_HOSTS = ['outlook.office365.com', 'smtp.office365.com', 'outlook.office.com', 'imap-mail.outlook.com', 'smtp-mail.outlook.com'];

export function isMicrosoftMailHost(value: string | null | undefined): boolean {
  const host = normalizeHost(value);
  return Boolean(host) && (MICROSOFT_HOSTS.includes(host) || host.endsWith('.office365.com'));
}

/**
 * The fix-table provider for an attempt: the card that was clicked, or for the
 * generic form what the mail host (first) or the address identifies.
 */
export function findFixProvider(input: {
  card?: string | null;
  email?: string | null;
  host?: string | null;
}): FixProvider | null {
  const card = String(input.card ?? '');
  if (card && card !== 'generic') {
    return CONNECT_FIX_PROVIDERS.find((entry) => entry.presetIds.includes(card)) ?? null;
  }
  const preset = findMailHostPreset({ email: input.email, host: normalizeHost(input.host) });
  if (!preset) return null;
  return CONNECT_FIX_PROVIDERS.find((entry) => entry.presetIds.includes(preset.id)) ?? null;
}

const CREDENTIAL_REASONS = new Set(['account_password_used', 'app_password_required', 'app_password_length', 'password_rejected']);
const UNREACHABLE_CODES = new Set(['connection_timeout', 'connection_refused', 'host_not_found']);
const UNREACHABLE_PHASES = new Set(['tcp', 'greeting', 'smtp_tcp', 'smtp_greeting']);
const TLS_PHASES = new Set(['tls', 'smtp_tls']);

/** The `provider` a connect_fix_* row is filed under (ACTIVATION_PROVIDERS in activation-events.ts). */
export type FixAnalyticsProvider =
  | 'gmail' | 'outlook' | 'fastmail' | 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic_imap' | 'unknown';

const ANALYTICS_CARDS = new Set(['gmail', 'outlook', 'fastmail', 'icloud', 'yahoo', 'zoho', 'yandex']);

export function fixAnalyticsProvider(card: string | null | undefined): FixAnalyticsProvider {
  const value = String(card ?? '');
  if (!value || value === 'generic') return 'generic_imap';
  return ANALYTICS_CARDS.has(value) ? (value as FixAnalyticsProvider) : 'unknown';
}

export interface ConnectFixInput {
  /** The modal card: 'generic', 'gmail', 'yahoo', 'icloud', 'zoho', 'yandex', 'fastmail'. */
  card: string;
  /** The route's lower-cased `error_code`. */
  errorCode: string | null | undefined;
  /** The route's `auth_reason`, when the failure was a rejected login. */
  reason?: string | null;
  /** The route's `phase`: 'authentication', 'tcp', 'smtp_authentication', ... */
  phase?: string | null;
  /** The host the failed half was tried on (the route's `host`). */
  host?: string | null;
  email?: string | null;
  username?: string | null;
  imapHost?: string | null;
  smtpHost?: string | null;
  /** The route's `relay_failed`: the relay retry was tried and failed too. */
  relayFailed?: boolean;
  /** The route's `imap_ok`: the IMAP half passed before SMTP failed. */
  imapOk?: boolean;
  /** 'both', 'imap' or 'smtp' (generic form only). */
  connectionMode?: string | null;
  /** Provider name for sentences that carry one when the table has none. */
  providerLabel?: string | null;
}

export interface SuggestedHost {
  protocol: 'imap' | 'smtp';
  host: string;
  label: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: string;
}

export interface ConnectFix {
  /** Stable row id: what the test table is keyed by. */
  row: string;
  /** The fix-table provider, or null for a row that is not provider-specific. */
  provider: FixProviderId | null;
  /** For connect_fix_shown / connect_fix_link_clicked. */
  analyticsProvider: FixAnalyticsProvider;
  steps: AuthHelpLine[];
  links: FixLink[];
  /** 'test_again' re-sends the form; 'use_outlook' switches to the Microsoft card. */
  action: 'test_again' | 'use_outlook';
  /** The password is the thing to replace: Test again clears and focuses that field only. */
  passwordProblem: boolean;
  /** Offer "Connect for reading only" (generic form, both halves, sending failed). */
  offerReceiveOnly: boolean;
  /** A step points at the Username field, which lives under Advanced. */
  showsUsernameField: boolean;
  /** A host the address's provider documents, when it differs from the one tried. */
  suggestedHost: SuggestedHost | null;
}

/**
 * Codes that are not about the mailbox (a session, a role, a plan cap, a
 * refused host name). The modal already has a specific answer for each.
 */
const NOT_A_MAILBOX_FAILURE = new Set([
  'session_expired', 'workspace_not_found', 'insufficient_role', 'inbox_limit_reached', 'login_already_connected',
  'own_site_host', 'port_not_allowed', 'host_not_allowed', 'host_invalid', 'save_failed',
  'microsoft_account_use_outlook', 'inbox_exists_other_provider', 'password_required', 'app_password_too_short',
]);

/** The one fix to show for a failed connect, or null when no row applies. Pure. */
export function connectFix(input: ConnectFixInput): ConnectFix | null {
  const code = String(input.errorCode ?? '').toLowerCase();
  if (!code || NOT_A_MAILBOX_FAILURE.has(code)) return null;

  const card = String(input.card ?? '') || 'generic';
  const generic = card === 'generic';
  const phase = String(input.phase ?? '');
  const smtpPhase = phase.startsWith('smtp_');
  const host = normalizeHost(input.host) || normalizeHost(smtpPhase ? input.smtpHost : input.imapHost);
  const label = String(input.providerLabel ?? '');
  const both = !input.connectionMode || input.connectionMode === 'both';

  const base = {
    analyticsProvider: fixAnalyticsProvider(card),
    action: 'test_again' as 'test_again' | 'use_outlook',
    passwordProblem: false,
    offerReceiveOnly: false,
    showsUsernameField: false,
    suggestedHost: null as SuggestedHost | null,
  };
  const lines = (keys: readonly string[], values: Record<string, string>): AuthHelpLine[] =>
    keys.map((key) => ({ key, values }));
  const withValues = (links: readonly FixLink[], values: Record<string, string>): FixLink[] =>
    links.map((link) => ({ ...link, values }));

  if (code === 'auth_failed') {
    const reason = String(input.reason ?? '') || 'password_rejected';

    // Microsoft 365 typed into the generic form. Password sign-in is off
    // there, so the fix is a different door, not a different password.
    if (generic && (isMicrosoftMailHost(input.imapHost) || isMicrosoftMailHost(input.smtpHost) || isMicrosoftMailHost(host))) {
      return {
        ...base,
        row: 'office365_use_outlook',
        provider: 'office365',
        steps: [{ key: 'connect.fix.office365.useOutlook' }],
        links: [],
        action: 'use_outlook',
      };
    }

    const fixProvider = findFixProvider({ card, email: input.email, host: generic ? normalizeHost(input.imapHost) || host : null });
    const values = { provider: fixProvider?.label ?? label };

    if (reason === 'imap_disabled') {
      const block = fixProvider?.imapDisabled;
      if (fixProvider && block) {
        return { ...base, row: `${fixProvider.id}_imap_disabled`, provider: fixProvider.id, steps: lines(block.steps, values), links: withValues(block.links, values) };
      }
      return { ...base, row: 'imap_disabled', provider: null, steps: [{ key: 'connect.imapDisabledDetail' }], links: [] };
    }

    if (reason === 'login_username_required') {
      const help = authFailureHelp({ reason, email: input.email, generic });
      return { ...base, row: 'login_username', provider: null, steps: help.lines, links: [], showsUsernameField: help.showsUsernameField };
    }

    if (reason === 'provider_refused_signin') {
      return { ...base, row: 'provider_refused', provider: fixProvider?.id ?? null, steps: [{ key: 'connect.providerRefusedDetail' }], links: [] };
    }

    if (!CREDENTIAL_REASONS.has(reason)) return null;

    // A provider we have steps for: its steps, whichever half refused.
    if (fixProvider?.credential) {
      const block = fixProvider.credential;
      const steps = lines(block.steps, values);
      if (reason === 'app_password_length') steps.unshift({ key: 'connect.appPasswordLengthDetail', values });
      return {
        ...base,
        row: `${fixProvider.id}_${reason === 'password_rejected' ? 'password_rejected' : 'app_password'}`,
        provider: fixProvider.id,
        steps,
        links: withValues(block.links, values),
        passwordProblem: true,
      };
    }

    // The sending half refused a login the reading half accepted, on a server
    // we have no steps for: a separate sending login, or reading only for now.
    if (smtpPhase && input.imapOk) {
      return {
        ...base,
        row: 'smtp_rejected',
        provider: null,
        steps: [
          { key: 'connect.fix.smtp.readingOk' },
          ...(generic ? [{ key: 'connect.fix.smtp.username' }] : []),
          ...(generic && both ? [{ key: 'connect.fix.smtp.readOnly' }] : []),
        ],
        links: [],
        offerReceiveOnly: generic && both,
        showsUsernameField: generic,
      };
    }

    // Anything else: what this module already says for the host, plus the
    // generator link when the provider has one.
    const help = authFailureHelp({
      reason,
      email: input.email,
      host: generic ? input.imapHost ?? host : null,
      smtpHost: generic ? input.smtpHost : null,
      username: generic ? input.username : null,
      generic,
      providerLabel: label,
    });
    const preset = findMailHostPreset({ email: input.email, host: generic ? host : null });
    const links: FixLink[] =
      preset?.requiresAppPassword && preset.appPasswordHelpUrl
        ? [{ id: `${preset.id}_app_passwords`, labelKey: 'connect.fix.link.appPasswords', url: preset.appPasswordHelpUrl, values: { provider: preset.label } }]
        : [];
    return {
      ...base,
      row: help.hostId ? `host_${help.hostId}` : reason === 'password_rejected' ? 'password_rejected' : 'app_password',
      provider: null,
      steps: help.lines,
      links,
      passwordProblem: true,
      showsUsernameField: help.showsUsernameField,
    };
  }

  // ── The server never answered, or answered with nothing usable ───────────
  const greetingFailure = (code === 'imap_protocol_error' || code === 'smtp_protocol_error') && phase.endsWith('greeting');
  if (UNREACHABLE_CODES.has(code) || greetingFailure || (UNREACHABLE_PHASES.has(phase) && code !== 'tls_handshake_failed')) {
    const protocol: 'imap' | 'smtp' = smtpPhase ? 'smtp' : 'imap';
    const steps: AuthHelpLine[] = [];
    if (host) {
      steps.push({ key: code === 'host_not_found' ? 'connect.fix.unreachable.notFound' : 'connect.fix.unreachable.tried', values: { host } });
    }
    let suggestedHost: SuggestedHost | null = null;
    if (generic) {
      const prefill = prefillFromDomain(emailDomain(String(input.email ?? '')));
      const documented = prefill ? (protocol === 'imap' ? prefill.imapHost : prefill.smtpHost) : '';
      if (prefill && documented && documented !== host) {
        suggestedHost = {
          protocol,
          host: documented,
          label: prefill.label,
          imapHost: prefill.imapHost,
          imapPort: prefill.imapPort,
          imapSecurity: prefill.imapSecurity,
          smtpHost: prefill.smtpHost,
          smtpPort: prefill.smtpPort,
          smtpSecurity: prefill.smtpSecurity,
        };
        steps.push({ key: 'connect.fix.unreachable.suggest', values: { provider: prefill.label, host: documented } });
      }
    }
    const blocked = Boolean(input.relayFailed) && code !== 'host_not_found';
    if (blocked) {
      steps.push({ key: 'connect.fix.unreachable.blocked' });
      steps.push({ key: 'connect.fix.unreachable.blockedNext' });
    } else if (!suggestedHost) {
      steps.push({ key: 'connect.fix.unreachable.check' });
    }
    const offerReceiveOnly = generic && both && protocol === 'smtp';
    if (offerReceiveOnly) steps.push({ key: 'connect.fix.smtp.readOnly' });
    return {
      ...base,
      row: blocked ? 'server_blocks_us' : code === 'host_not_found' ? 'host_not_found' : 'server_unreachable',
      provider: null,
      steps,
      links: [],
      offerReceiveOnly,
      suggestedHost,
    };
  }

  // ── TLS: say which two transports were tried, and what to change ─────────
  if (code === 'tls_handshake_failed' || TLS_PHASES.has(phase)) {
    return {
      ...base,
      row: 'tls',
      provider: null,
      steps: [
        { key: 'connect.fix.tls.tried', values: smtpPhase ? { tlsPort: '465', starttlsPort: '587' } : { tlsPort: '993', starttlsPort: '143' } },
        ...(generic ? [{ key: 'connect.fix.tls.next' }] : []),
      ],
      links: [],
    };
  }

  return null;
}

const SAFE_FAILURE_PHASES = new Set([
  'tcp', 'tls', 'greeting', 'authentication', 'smtp_tcp', 'smtp_tls', 'smtp_greeting', 'smtp_authentication',
]);

/**
 * The extra fields a connect route's failure JSON carries so the panel can
 * pick its row: the host the failed half was tried on, the phase, whether the
 * attempt went through the relay, and whether the relay retry failed too.
 *
 * Server configuration and enums only. The address and the password are not
 * inputs, so neither can be returned, and a host that is not a plain hostname
 * is left out rather than echoed.
 */
export function connectFailureContext(input: {
  host?: string | null;
  phase?: string | null;
  viaRelay?: boolean;
  relayAlsoFailed?: boolean;
  imapOk?: boolean;
}): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {
    via_relay: Boolean(input.viaRelay),
    relay_failed: Boolean(input.relayAlsoFailed),
  };
  const host = normalizeHost(input.host);
  if (host && host.length <= 253 && /^[a-z0-9.-]+$/.test(host)) out.host = host;
  if (typeof input.phase === 'string' && SAFE_FAILURE_PHASES.has(input.phase)) out.phase = input.phase;
  if (typeof input.imapOk === 'boolean') out.imap_ok = input.imapOk;
  return out;
}
