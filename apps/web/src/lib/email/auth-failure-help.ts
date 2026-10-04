// Browser-safe: the connect modal calls this on render. Nothing here may reach
// for a node builtin, and the only runtime import is the host-preset table the
// modal already bundles.
import { findMailHostPreset } from '@/lib/email-providers/host-presets';
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
    presetIds: ['ionos'],
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
