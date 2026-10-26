/**
 * Email-first inbox detection for the /onboarding inbox step (plan A3).
 *
 * One address in, one answer out: which panel to show (`kind`), what to call
 * the provider, and the server settings when we know them. Two halves:
 *
 *   detectFromAddress(email)    browser, instant, no network. The static
 *                               table (host-presets.ts) plus the consumer
 *                               Microsoft and Proton domains. Null means "ask
 *                               the server", never "unknown".
 *   detectInboxDomain(domain)   server, in inbox-detect-server.ts (GET
 *                               /api/onboarding/detect). The same table, then
 *                               the domain's MX (Microsoft 365, Google
 *                               Workspace), then autodiscover.ts (SRV, MX,
 *                               ISPDB, ISPDB on the MX base domain).
 *
 * This file is client-safe; the server half is split out because
 * autodiscover.ts reaches node:dns through host-guard.ts.
 */
import {
  emailDomain,
  findMailHostPreset,
  prefillFromPreset,
  type MailHostPrefill,
} from '../email-providers/host-presets.ts';
import { isMicrosoftConsumerDomain } from '../email-providers/microsoft-accounts.ts';

/** The provider panels the inbox step knows. `imap` = any other mailbox. */
export const INBOX_KINDS = [
  'gmail', 'google_workspace', 'icloud', 'yahoo', 'aol', 'gmx', 'web_de',
  'outlook', 'microsoft365', 'fastmail', 'zoho', 'yandex', 'proton', 'imap',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxDetectSource = 'table' | 'srv' | 'mx' | 'ispdb' | 'ispdb_mx' | 'none';

export interface InboxDetection {
  kind: InboxKind;
  /** Provider name to show ("Strato", "Google Workspace"), or null. */
  label: string | null;
  source: InboxDetectSource;
  /** IMAP/SMTP settings when known (null for Microsoft, Proton, or nothing found). */
  settings: MailHostPrefill | null;
  /** True when the address is on the customer's own domain, not the provider's. */
  customDomain: boolean;
}

/** Preset ids (host-presets.ts) that have a panel of their own. */
const KIND_BY_PRESET: Record<string, InboxKind> = {
  gmail: 'gmail',
  icloud: 'icloud',
  yahoo: 'yahoo',
  aol: 'aol',
  gmx: 'gmx',
  'web-de': 'web_de',
  fastmail: 'fastmail',
  zoho: 'zoho',
  yandex: 'yandex',
};

const PROTON_DOMAINS = new Set(['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me']);

/** Country variants the table does not list one by one (yahoo.es, gmx.fr, ...). */
function familyKind(domain: string): InboxKind | null {
  if (/^(yahoo|ymail)\.[a-z]{2,3}(\.[a-z]{2})?$/.test(domain)) return 'yahoo';
  if (/^gmx\.[a-z]{2,3}(\.[a-z]{2})?$/.test(domain)) return 'gmx';
  return null;
}

/** The family's table entry, so a country variant still gets settings. */
function familyPreset(kind: InboxKind): MailHostPrefill | null {
  const sample = kind === 'yahoo' ? 'x@yahoo.com' : kind === 'gmx' ? 'x@gmx.net' : null;
  const preset = sample ? findMailHostPreset({ email: sample }) : null;
  return preset ? prefillFromPreset(preset) : null;
}

/** Table answer for a domain, or null. Shared by both halves. */
export function detectFromTable(domain: string): InboxDetection | null {
  if (!domain) return null;
  if (isMicrosoftConsumerDomain(domain)) {
    return { kind: 'outlook', label: 'Outlook', source: 'table', settings: null, customDomain: false };
  }
  if (PROTON_DOMAINS.has(domain)) {
    return { kind: 'proton', label: 'Proton Mail', source: 'table', settings: null, customDomain: false };
  }
  const preset = findMailHostPreset({ email: `x@${domain}` });
  if (preset) {
    const settings = prefillFromPreset(preset);
    // A domain that matched by host suffix rather than by the provider's own
    // domain list (a subdomain of migadu.com, say) is still a known host.
    const own = Boolean(preset.domains?.includes(domain));
    const kind = KIND_BY_PRESET[preset.id] ?? 'imap';
    return { kind, label: preset.label, source: 'table', settings, customDomain: !own };
  }
  const family = familyKind(domain);
  if (family) {
    const settings = familyPreset(family);
    return { kind: family, label: settings?.label ?? null, source: 'table', settings, customDomain: false };
  }
  return null;
}

/**
 * Instant, in the browser. Null when the address is not complete yet or the
 * table does not know its domain (then call the detect endpoint).
 */
export function detectFromAddress(email: string | null | undefined): InboxDetection | null {
  const value = String(email ?? '').trim();
  if (!isCompleteAddress(value)) return null;
  return detectFromTable(emailDomain(value));
}

/** "a@b.co": something before the @, and a dotted domain that is not still being typed. */
export function isCompleteAddress(value: string | null | undefined): boolean {
  const v = String(value ?? '').trim();
  const at = v.lastIndexOf('@');
  if (at < 1) return false;
  const domain = v.slice(at + 1).toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) && !/\s/.test(v);
}

/**
 * The ?provider= slug from a /connect/<slug> page, as a panel to start on
 * before an address is typed. Only the panels whose steps do not depend on the
 * address; everything else waits for detection.
 */
export function kindFromProviderSlug(slug: string | null | undefined): InboxKind | null {
  switch (String(slug ?? '').toLowerCase()) {
    case 'gmail': return 'gmail';
    case 'google-workspace': return 'google_workspace';
    case 'icloud': return 'icloud';
    case 'yahoo': return 'yahoo';
    case 'aol': return 'aol';
    case 'gmx': return 'gmx';
    case 'web-de': case 'webde': return 'web_de';
    case 'outlook': case 'hotmail': return 'outlook';
    case 'office365': case 'microsoft-365': return 'microsoft365';
    case 'fastmail': return 'fastmail';
    case 'zoho': return 'zoho';
    case 'yandex': return 'yandex';
    case 'proton': return 'proton';
    default: return null;
  }
}

/** Panels whose mailbox signs in with Microsoft, not a password. */
export function isMicrosoftKind(kind: InboxKind | null | undefined): boolean {
  return kind === 'outlook' || kind === 'microsoft365';
}

/** The `provider` an onboarding funnel row is filed under (ACTIVATION_PROVIDERS). */
export function funnelProviderForKind(kind: InboxKind | null | undefined): string {
  switch (kind) {
    case 'gmail': case 'google_workspace': return 'gmail';
    case 'outlook': case 'microsoft365': return 'outlook';
    case 'icloud': case 'yahoo': case 'aol': case 'gmx': case 'web_de':
    case 'fastmail': case 'zoho': case 'yandex':
      return kind;
    case 'imap': return 'generic_imap';
    default: return 'unknown';
  }
}

/** The branded app-password route's `service`, when this panel uses it. */
const APP_PASSWORD_SERVICE: Partial<Record<InboxKind, string>> = {
  gmail: 'gmail',
  icloud: 'icloud',
  yahoo: 'yahoo',
  yandex: 'yandex',
};

export interface ConnectRequest {
  endpoint: '/api/inboxes/app-password' | '/api/inboxes/fastmail-app-password' | '/api/inboxes/imap';
  body: Record<string, unknown>;
}

export interface ManualServers {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Login name when it is not the address (generic route only). Blank = the address. */
  username?: string;
}

function securityFor(protocol: 'imap' | 'smtp', port: number): 'tls' | 'starttls' {
  if (protocol === 'imap') return port === 143 ? 'starttls' : 'tls';
  return port === 587 ? 'starttls' : 'tls';
}

/**
 * Which existing connect route a detection goes to, and with what body. The
 * routes are the dashboard's own (no forked backend):
 *
 *   gmail / icloud / yahoo / yandex on the provider's own domain
 *                         -> /api/inboxes/app-password { service }
 *   fastmail (own domain) -> /api/inboxes/fastmail-app-password
 *   everything else       -> /api/inboxes/imap with the detected (or typed)
 *                            servers; `readOnly` sends mode 'imap'
 *
 * A read-only connection always takes the generic route, the only one with a
 * connection mode. Returns null when there is nothing to connect with yet
 * (Microsoft, Proton, or no servers for an unknown domain).
 */
export function connectRequestFor(input: {
  detection: InboxDetection;
  email: string;
  password: string;
  readOnly?: boolean;
  manual?: ManualServers | null;
}): ConnectRequest | null {
  const { detection, readOnly = false } = input;
  const email = String(input.email ?? '').trim().toLowerCase();
  const appPassword = String(input.password ?? '');
  if (isMicrosoftKind(detection.kind) || detection.kind === 'proton') return null;

  const service = APP_PASSWORD_SERVICE[detection.kind];
  if (!readOnly && service && !detection.customDomain) {
    const body: Record<string, unknown> = { service, email, appPassword };
    if (service === 'yandex') body.yandexAccountType = 'personal';
    return { endpoint: '/api/inboxes/app-password', body };
  }
  if (!readOnly && detection.kind === 'fastmail' && !detection.customDomain) {
    return { endpoint: '/api/inboxes/fastmail-app-password', body: { email, appPassword } };
  }

  const username = String(input.manual?.username ?? '').trim();
  const s = detection.settings;
  const servers = s
    ? { imapHost: s.imapHost, imapPort: s.imapPort, imapSecurity: s.imapSecurity, smtpHost: s.smtpHost, smtpPort: s.smtpPort, smtpSecurity: s.smtpSecurity }
    : input.manual && input.manual.imapHost.trim()
      ? {
          imapHost: input.manual.imapHost.trim().toLowerCase(),
          imapPort: input.manual.imapPort,
          imapSecurity: securityFor('imap', input.manual.imapPort),
          smtpHost: input.manual.smtpHost.trim().toLowerCase(),
          smtpPort: input.manual.smtpPort,
          smtpSecurity: securityFor('smtp', input.manual.smtpPort),
        }
      : null;
  if (!servers) return null;
  if (readOnly) {
    return {
      endpoint: '/api/inboxes/imap',
      body: { email, username, appPassword, mode: 'imap', imapHost: servers.imapHost, imapPort: servers.imapPort, imapSecurity: servers.imapSecurity },
    };
  }
  if (!servers.smtpHost) return null;
  return { endpoint: '/api/inboxes/imap', body: { email, username, appPassword, mode: 'both', ...servers } };
}

/** A sample address on each panel's own domain, for its table settings. */
const SAMPLE_DOMAIN: Partial<Record<InboxKind, string>> = {
  gmail: 'gmail.com', google_workspace: 'gmail.com', icloud: 'icloud.com', yahoo: 'yahoo.com', aol: 'aol.com',
  gmx: 'gmx.net', web_de: 'web.de', fastmail: 'fastmail.com', zoho: 'zoho.com', yandex: 'yandex.com',
};

/**
 * The detection to connect with when the user picked a panel by hand (the
 * fallback list, "Not right?", or ?provider=). Keeps what detection found when
 * it is the same provider; otherwise takes the provider's table settings and
 * treats the address as a custom domain unless it is on the provider's own.
 */
export function detectionForChoice(kind: InboxKind, email: string, detected: InboxDetection | null): InboxDetection {
  if (detected && detected.kind === kind) return detected;
  if (kind === 'imap') {
    return { kind, label: null, source: 'none', settings: detected?.settings ?? null, customDomain: true };
  }
  const sample = SAMPLE_DOMAIN[kind];
  const preset = sample ? detectFromTable(sample) : null;
  const own = detectFromTable(emailDomain(String(email ?? '')));
  const onOwnDomain = Boolean(own && own.kind === kind && !own.customDomain);
  return {
    kind,
    label: kind === 'google_workspace' ? 'Google Workspace' : preset?.label ?? null,
    source: 'none',
    settings: preset?.settings ?? null,
    customDomain: kind === 'google_workspace' ? true : !onOwnDomain,
  };
}

export type PanelLinkId = 'two_step' | 'app_passwords' | 'imap_setting';

/**
 * The external links a panel shows BEFORE any failure (plan A4), one per
 * checklist step. Google links carry `authuser=<address>` so a browser signed
 * in to several Google accounts opens the right one (report 33, rec 3).
 * App-password pages come from the host-preset table: the same URLs the
 * dashboard modal and the fix panel use.
 */
export function panelLinks(
  kind: InboxKind | null | undefined,
  email: string,
  settings?: MailHostPrefill | null,
): Partial<Record<PanelLinkId, string>> {
  const address = isCompleteAddress(email) ? String(email).trim().toLowerCase() : '';
  const google = (url: string) => (address ? `${url}?authuser=${encodeURIComponent(address)}` : url);
  const presetUrl = (domain: string) => findMailHostPreset({ email: `x@${domain}` })?.appPasswordHelpUrl ?? undefined;
  switch (kind) {
    case 'gmail': case 'google_workspace':
      return {
        two_step: google('https://myaccount.google.com/signinoptions/two-step-verification'),
        app_passwords: google('https://myaccount.google.com/apppasswords'),
      };
    case 'icloud': return { app_passwords: presetUrl('icloud.com') };
    case 'yahoo': return { app_passwords: presetUrl('yahoo.com') };
    case 'aol': return { app_passwords: presetUrl('aol.com') };
    case 'fastmail': return { app_passwords: presetUrl('fastmail.com') };
    case 'zoho': return { app_passwords: presetUrl('zoho.com') };
    case 'yandex': return { app_passwords: presetUrl('yandex.com') };
    case 'gmx': return { imap_setting: 'https://hilfe.gmx.net/pop-imap/einschalten.html' };
    case 'web_de': return { imap_setting: 'https://hilfe.web.de/pop-imap/einschalten.html' };
    case 'imap':
      return settings?.requiresAppPassword && settings.appPasswordHelpUrl ? { app_passwords: settings.appPasswordHelpUrl } : {};
    default: return {};
  }
}
