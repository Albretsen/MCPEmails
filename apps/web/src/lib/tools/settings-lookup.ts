/**
 * The free IMAP/SMTP settings lookup at /tools/email-settings-lookup.
 *
 * ── Why this is not autodiscover.ts ─────────────────────────────────────────
 *
 * `email-providers/autodiscover.ts` answers the same question for the connect
 * form, on the server, behind a login, with node:dns. This page is public and
 * runs in the visitor's browser, so it cannot use any of that: autodiscover.ts
 * imports host-guard.ts, which imports node:dns at module scope and does not
 * build into a client bundle (see the note at the top of mail-ports.ts).
 *
 * It keeps the same order of authority and the same tables, and reaches DNS a
 * different way:
 *
 *  1. registry  PROVIDERS from connect/providers.mjs, matched on the address
 *               domain. Probe-verified hosts, and the same values the
 *               /connect/<slug> page the result links to prints.
 *  2. host      A mail server name typed instead of an address
 *               (ex4.mail.ovh.net), matched with findMailHostPreset.
 *  3. table     MAIL_HOST_PRESETS from host-presets.ts, by address domain.
 *  4. srv       RFC 6186 service records, through DNS over HTTPS.
 *  5. mx        The MX host, matched with findMailHostPresetByMx, then against
 *               the registry by the MX name's registrable domain.
 *  6. ispdb     Mozilla's autoconfig database (autoconfig.thunderbird.net).
 *
 * DNS goes to Cloudflare's JSON DoH endpoint. Both it and the ISPDB answer
 * `Access-Control-Allow-Origin: *` (checked 2026-10-20), so the browser asks
 * them directly and no request reaches our servers. That is also why this is
 * not a public wrapper around /api/inboxes/autodiscover: that route is
 * authenticated on purpose, because an open endpoint that makes DNS queries on
 * a name the caller picks is a traffic amplifier. Here the visitor's own
 * browser makes the queries, to two fixed origins, with the domain only ever
 * a query parameter or a percent-encoded path segment.
 *
 * Both origins must be in the CSP `connect-src` (src/lib/csp.ts) or every
 * lookup that reaches step 4 fails closed and the page says it found nothing.
 *
 * Browser-safe: no node built-ins, and the only imports are the two tables and
 * the port allowlist, which are themselves browser-safe.
 */

import type { SmtpSecurity as MailSecurity } from '../email-providers/imap-presets.ts';
import {
  findMailHostPreset,
  findMailHostPresetByMx,
  type MailHostPreset,
} from '../email-providers/host-presets.ts';
import { isMicrosoftConsumerDomain } from '../email-providers/microsoft-accounts.ts';
import { isAllowedMailPort } from '../email/mail-ports.ts';

export const DOH_ORIGIN = 'https://cloudflare-dns.com/dns-query';
export const ISPDB_ORIGIN = 'https://autoconfig.thunderbird.net/v1.1/';

/** Per request. A domain whose nameserver does not answer costs this, once. */
const FETCH_TIMEOUT_MS = 4000;
const ISPDB_MAX_BYTES = 64 * 1024;

export interface MailServer {
  host: string;
  port: number;
  security: MailSecurity;
}

/** The slice of a providers.mjs entry this tool needs. Built by the page. */
export interface RegistryEntry {
  slug: string;
  name: string;
  domain: string | null;
  status: 'supported' | 'limited';
  imap: MailServer | null;
  smtp: MailServer | null;
  /** Locales the /connect/<slug> page exists in. */
  locales: readonly string[];
}

export type LookupSource = 'registry' | 'host' | 'table' | 'srv' | 'mx' | 'ispdb';

export type LookupResult =
  | { kind: 'invalid' }
  | {
      /** Microsoft accounts: no password sign-in over IMAP, see below. */
      kind: 'microsoft';
      domain: string;
      slug: 'outlook' | 'office365';
      mx: string[];
    }
  | {
      /** A provider whose /connect page says it cannot be connected over IMAP. */
      kind: 'limited';
      domain: string;
      slug: string;
      label: string;
      mx: string[];
    }
  | {
      kind: 'found';
      domain: string;
      label: string | null;
      imap: MailServer;
      smtp: MailServer;
      source: LookupSource;
      /** /connect/<slug> exists for this provider and accepts a signup hint. */
      slug: string | null;
      requiresAppPassword: boolean;
      appPasswordHelpUrl: string | null;
      mx: string[];
    }
  | {
      kind: 'notFound';
      domain: string;
      mx: string[];
      /**
       * The MX query got no usable answer (network error, timeout, a blocked
       * request, SERVFAIL). The page must not then say the domain has no MX.
       */
      dnsFailed: boolean;
    };

/* ──────────────────────────────────────────────────────────────────────────
 * Input
 * ────────────────────────────────────────────────────────────────────────── */

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * An email address, a bare domain or a mail server name, reduced to the name
 * to look up. Unicode domains come back in their punycode form, which is what
 * DNS and the tables hold. Null for anything that is not a public DNS name.
 */
export function parseLookupInput(raw: unknown): { domain: string; isAddress: boolean } | null {
  let value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return null;
  const isAddress = value.includes('@');
  if (isAddress) value = value.slice(value.lastIndexOf('@') + 1);
  // Tolerate a pasted URL or "host:port".
  value = value.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  while (value.endsWith('.')) value = value.slice(0, -1);
  if (!value) return null;
  let host: string;
  try {
    host = new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
  if (host.length > 253 || host.includes(':') || host.startsWith('[')) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => l.length <= 63 && LABEL.test(l))) return null;
  // An all-numeric TLD means an IP address, which has no MX and no provider.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return { domain: host, isAddress };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Naming the provider
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * host-presets.ts ids that have a /connect page, and its slug. Ids not listed
 * (OpenSRS) have none. IONOS runs one page for all its country platforms.
 */
export const PRESET_SLUG: Readonly<Record<string, string>> = Object.freeze({
  'ionos-de': 'ionos',
  'ionos-uk': 'ionos',
  'ionos-fr': 'ionos',
  'ionos-es': 'ionos',
  'ionos-it': 'ionos',
  ionos: 'ionos',
  hostinger: 'hostinger',
  'ovh-exchange': 'ovh',
  ovh: 'ovh',
  dreamhost: 'dreamhost',
  titan: 'titan',
  privateemail: 'namecheap',
  migadu: 'migadu',
  uhserver: 'inmotion',
  zoho: 'zoho',
  gmx: 'gmx',
  mailcom: 'mail-com',
  fastmail: 'fastmail',
  gmail: 'gmail',
  icloud: 'icloud',
  yahoo: 'yahoo',
  yandex: 'yandex',
});

/**
 * Presets whose host carries a per-customer cluster number (ex4.mail.ovh.net,
 * secure12.uhserver.com, mail.b.hostedemail.com). When the visitor typed such
 * a host, it is their server and must be shown back unchanged: the preset's
 * own host is only a generic fallback, and OVH's connect page says the number
 * "works for one customer and returns nothing for the next".
 */
const CLUSTER_PRESETS = new Set(['ovh-exchange', 'uhserver', 'hostedemail']);

/**
 * Addresses of the providers the registry marks `limited`, beyond the single
 * `domain` the registry records for each. Checked with dig on 2026-10-20.
 */
const LIMITED_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  'proton.me': 'proton',
  'pm.me': 'proton',
  'protonmail.ch': 'proton',
  'tuta.com': 'tutanota',
  'tuta.io': 'tutanota',
  'tutanota.de': 'tutanota',
});

/**
 * MX names that identify a mailbox this tool must not hand IMAP settings for.
 * Checked with dig on 2026-10-20: microsoft.com -> *.mail.protection.outlook.com,
 * proton.me -> mail.protonmail.ch, tuta.com -> mail.tutanota.de,
 * hey.com -> home-mx.app.hey.com.
 */
const MX_SPECIAL: readonly { suffix: string; slug: string; microsoft?: true }[] = [
  { suffix: '.mail.protection.outlook.com', slug: 'office365', microsoft: true },
  { suffix: '.protonmail.ch', slug: 'proton' },
  { suffix: 'mail.tutanota.de', slug: 'tutanota' },
  { suffix: '.app.hey.com', slug: 'hey' },
];

function suffixMatch(host: string, suffix: string): boolean {
  return suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix || host.endsWith(`.${suffix}`);
}

/** Second-level labels under which a country TLD sells names (example.co.uk). */
const SLD = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or']);

/** "mailserver.purelymail.com" -> "purelymail.com"; "mx.foo.co.uk" -> "foo.co.uk". */
export function registrableDomain(host: string): string {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && SLD.has(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

function registryBySlug(registry: readonly RegistryEntry[], slug: string | null | undefined): RegistryEntry | null {
  return slug ? registry.find((p) => p.slug === slug) ?? null : null;
}

/**
 * The registry provider serving a mail host: an exact IMAP host match first,
 * then one whose IMAP host sits under the same registrable domain. Where two
 * providers share a host (Verizon and AOL both use imap.aol.com) the one whose
 * own domain is that registrable domain wins.
 */
export function registryByHost(registry: readonly RegistryEntry[], host: string): RegistryEntry | null {
  const usable = registry.filter((p) => p.status === 'supported' && p.imap && p.smtp);
  const exact = usable.filter((p) => p.imap!.host === host);
  const base = registrableDomain(host);
  const pick = (list: RegistryEntry[]) => list.find((p) => p.domain === base) ?? list[0] ?? null;
  if (exact.length) return pick(exact);
  return pick(usable.filter((p) => registrableDomain(p.imap!.host) === base));
}

function serverFromPreset(preset: MailHostPreset, protocol: 'imap' | 'smtp'): MailServer {
  return protocol === 'imap'
    ? { host: preset.imapHost, port: preset.imapPort, security: preset.imapSecurity }
    : { host: preset.smtpHost, port: preset.smtpPort, security: preset.smtpSecurity };
}

function presetFound(
  preset: MailHostPreset,
  domain: string,
  source: LookupSource,
  registry: readonly RegistryEntry[],
  mx: string[],
  typedHost?: string,
): Extract<LookupResult, { kind: 'found' }> {
  const imap = serverFromPreset(preset, 'imap');
  const smtp = serverFromPreset(preset, 'smtp');
  let label = preset.label;
  if (typedHost && CLUSTER_PRESETS.has(preset.id)) {
    imap.host = typedHost;
    smtp.host = typedHost;
    // OVH Email Pro (pro4.mail.ovh.net) shares the Exchange suffix and, per
    // the OVH connect page, the same ports; only the name differs.
    if (preset.id === 'ovh-exchange' && typedHost.startsWith('pro')) label = 'OVH Email Pro';
  }
  // A Gmail mailbox found through its MX is a Google Workspace domain.
  const workspace = preset.id === 'gmail' && source === 'mx';
  const entry = registryBySlug(registry, workspace ? 'google-workspace' : PRESET_SLUG[preset.id]);
  return {
    kind: 'found',
    domain,
    label: workspace && entry ? entry.name : label,
    imap,
    smtp,
    source,
    slug: entry?.slug ?? null,
    requiresAppPassword: preset.requiresAppPassword === true,
    appPasswordHelpUrl: preset.appPasswordHelpUrl ?? null,
    mx,
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * DNS over HTTPS and the ISPDB
 * ────────────────────────────────────────────────────────────────────────── */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const DNS_TYPE = { MX: 15, SRV: 33 } as const;

async function quiet<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
}

/**
 * The `data` strings of one record type: [] when the name has none (NOERROR
 * with no answer, or NXDOMAIN), null when DNS could not be asked or did not
 * answer (network error, timeout, SERVFAIL), so the caller can tell "no
 * records" from "no idea".
 */
async function doh(fetcher: Fetcher, name: string, type: keyof typeof DNS_TYPE): Promise<string[] | null> {
  return quiet(async () => {
    const url = `${DOH_ORIGIN}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetcher(url, { headers: { Accept: 'application/dns-json' }, signal: timeoutSignal() });
    if (!res.ok) return null;
    const body = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
    if (body?.Status === 3) return [];
    if (body?.Status !== 0) return null;
    if (!Array.isArray(body.Answer)) return [];
    return body.Answer.filter((a) => a?.type === DNS_TYPE[type] && typeof a.data === 'string').map((a) => a.data as string);
  }, null as string[] | null);
}

const clean = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');

/** "10 aspmx1.migadu.com." records, lowest preference first, as bare names. */
export function parseMx(data: readonly string[]): string[] {
  return data
    .map((d) => d.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^\d+$/.test(p[0]) && clean(p[1]))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map((p) => clean(p[1]))
    .filter((h, i, all) => all.indexOf(h) === i);
}

/**
 * One RFC 6186 service's records ("0 1 993 imap.migadu.com.") to a server.
 * A lone "." target means the service is explicitly not offered. Ports outside
 * the allowlist the connect routes enforce are dropped, so the page never
 * shows a setting MCPEmails would then refuse.
 */
export function parseSrv(
  data: readonly string[],
  protocol: 'imap' | 'smtp',
  security: MailSecurity,
): MailServer | null {
  const records = data
    .map((d) => d.trim().split(/\s+/))
    .filter((p) => p.length === 4 && p.slice(0, 3).every((n) => /^\d+$/.test(n)))
    .map(([priority, weight, port, target]) => ({
      priority: Number(priority),
      weight: Number(weight),
      port: Number(port),
      host: clean(target),
    }));
  if (records.length === 1 && records[0].host === '') return null;
  const best = records
    .filter((r) => r.host && parseLookupInput(r.host) && isAllowedMailPort(protocol, r.port))
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
  return best ? { host: best.host, port: best.port, security } : null;
}

const SRV_SERVICES: readonly { label: string; protocol: 'imap' | 'smtp'; security: MailSecurity }[] = [
  { label: '_imaps._tcp', protocol: 'imap', security: 'tls' },
  { label: '_imap._tcp', protocol: 'imap', security: 'starttls' },
  { label: '_submissions._tcp', protocol: 'smtp', security: 'tls' },
  { label: '_submission._tcp', protocol: 'smtp', security: 'starttls' },
];

function firstTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

/** IMAP and SMTP out of a Thunderbird autoconfig document. Plaintext entries are no answer. */
export function parseIspdb(xml: string): { imap: MailServer | null; smtp: MailServer | null; label: string | null } {
  const read = (pattern: RegExp, protocol: 'imap' | 'smtp'): MailServer | null => {
    const block = xml.match(pattern)?.[0];
    if (!block) return null;
    const host = clean(firstTag(block, 'hostname') ?? '');
    const port = Number(firstTag(block, 'port'));
    const socket = (firstTag(block, 'socketType') ?? '').toUpperCase();
    const security: MailSecurity | null = socket === 'SSL' ? 'tls' : socket === 'STARTTLS' ? 'starttls' : null;
    if (!host || !parseLookupInput(host) || !security || !isAllowedMailPort(protocol, port)) return null;
    return { host, port, security };
  };
  if (typeof xml !== 'string' || !xml) return { imap: null, smtp: null, label: null };
  return {
    imap: read(/<incomingServer[^>]*type="imap"[^>]*>[\s\S]*?<\/incomingServer>/i, 'imap'),
    smtp: read(/<outgoingServer[^>]*type="smtp"[^>]*>[\s\S]*?<\/outgoingServer>/i, 'smtp'),
    label: firstTag(xml, 'displayName'),
  };
}

async function ispdb(fetcher: Fetcher, domain: string) {
  return quiet(async () => {
    const res = await fetcher(`${ISPDB_ORIGIN}${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/xml, text/xml' },
      redirect: 'error',
      signal: timeoutSignal(),
    });
    // 404 is the normal answer for any custom domain.
    if (!res.ok) return null;
    return parseIspdb((await res.text()).slice(0, ISPDB_MAX_BYTES));
  }, null);
}

/* ──────────────────────────────────────────────────────────────────────────
 * The lookup
 * ────────────────────────────────────────────────────────────────────────── */

export interface LookupDeps {
  registry: readonly RegistryEntry[];
  fetch: Fetcher;
}

export async function lookupMailSettings(raw: string, deps: LookupDeps): Promise<LookupResult> {
  const input = parseLookupInput(raw);
  if (!input) return { kind: 'invalid' };
  const { domain, isAddress } = input;
  const { registry } = deps;

  // Personal Microsoft accounts: Microsoft switched off password sign-in for
  // IMAP and SMTP on 2024-09-16 (see microsoft-accounts.ts). Server names
  // would only send the visitor to a login that cannot succeed.
  if (isMicrosoftConsumerDomain(domain)) return { kind: 'microsoft', domain, slug: 'outlook', mx: [] };

  // 1. The registry, on the address domain.
  const limitedSlug = LIMITED_DOMAINS[domain];
  const byDomain = registryBySlug(registry, limitedSlug) ?? registry.find((p) => p.domain === domain) ?? null;
  if (byDomain?.status === 'limited') {
    return { kind: 'limited', domain, slug: byDomain.slug, label: byDomain.name, mx: [] };
  }
  if (byDomain?.imap && byDomain.smtp) {
    const preset = findMailHostPreset({ host: byDomain.imap.host });
    return {
      kind: 'found',
      domain,
      label: byDomain.name,
      imap: { ...byDomain.imap },
      smtp: { ...byDomain.smtp },
      source: 'registry',
      slug: byDomain.slug,
      requiresAppPassword: preset?.requiresAppPassword === true,
      appPasswordHelpUrl: preset?.appPasswordHelpUrl ?? null,
      mx: [],
    };
  }

  // 2. A server name typed instead of an address. An "mx" name is a receiving
  //    host, not the IMAP server (mx1.mail.ovh.net is not an Exchange cluster),
  //    so it is matched the way an MX record is, which also catches names like
  //    aspmx.l.google.com that share no label with the provider's IMAP host.
  if (!isAddress) {
    const looksLikeMx = /^(?:asp)?mx[0-9-]*\./.test(domain);
    const byHost = looksLikeMx ? null : findMailHostPreset({ host: domain });
    if (byHost) return presetFound(byHost, domain, 'host', registry, [], domain);
    const byMx = findMailHostPresetByMx(domain);
    if (byMx) return presetFound(byMx, domain, 'mx', registry, [domain]);
  }

  // 3. The host-presets table, on the address domain.
  const fromTable = findMailHostPreset({ email: `x@${domain}` });
  if (fromTable) return presetFound(fromTable, domain, 'table', registry, []);

  // 4 and 5. SRV and MX, all at once: five independent queries.
  const [srvAnswers, mxData] = await Promise.all([
    Promise.all(SRV_SERVICES.map((s) => doh(deps.fetch, `${s.label}.${domain}`, 'SRV'))),
    doh(deps.fetch, domain, 'MX'),
  ]);
  const dnsFailed = mxData === null;
  const mx = parseMx(mxData ?? []);

  for (const host of mx) {
    const special = MX_SPECIAL.find((s) => suffixMatch(host, s.suffix));
    if (!special) continue;
    if (special.microsoft) return { kind: 'microsoft', domain, slug: 'office365', mx };
    const entry = registryBySlug(registry, special.slug);
    if (entry) return { kind: 'limited', domain, slug: entry.slug, label: entry.name, mx };
  }

  let imap: MailServer | null = null;
  let smtp: MailServer | null = null;
  for (let i = 0; i < SRV_SERVICES.length; i += 1) {
    const service = SRV_SERVICES[i];
    const found = parseSrv(srvAnswers[i] ?? [], service.protocol, service.security);
    if (!found) continue;
    // The implicit-TLS variant of each pair is listed first and wins.
    if (service.protocol === 'imap' && !imap) imap = found;
    if (service.protocol === 'smtp' && !smtp) smtp = found;
  }
  let source: LookupSource | null = imap ? 'srv' : null;

  let mxPreset: MailHostPreset | null = null;
  let mxEntry: RegistryEntry | null = null;
  for (const host of mx) {
    mxPreset = findMailHostPresetByMx(host);
    if (mxPreset) break;
    mxEntry = registryByHost(registry, host);
    if (mxEntry) break;
  }

  if (!imap && !smtp && mxPreset) return presetFound(mxPreset, domain, 'mx', registry, mx);
  if (mxPreset) {
    imap ??= serverFromPreset(mxPreset, 'imap');
    smtp ??= serverFromPreset(mxPreset, 'smtp');
  } else if (mxEntry?.imap && mxEntry.smtp) {
    imap ??= { ...mxEntry.imap };
    smtp ??= { ...mxEntry.smtp };
  }
  if (imap && !source) source = 'mx';

  // 6. The ISPDB, only when DNS left a half open.
  let ispdbLabel: string | null = null;
  if (!imap || !smtp) {
    const parsed = await ispdb(deps.fetch, domain);
    if (parsed) {
      if (!imap && parsed.imap) {
        imap = parsed.imap;
        source = 'ispdb';
      }
      smtp ??= parsed.smtp;
      ispdbLabel = parsed.label;
    }
  }

  // Both halves or nothing, as in autodiscover.ts.
  if (!imap || !smtp || !source) return { kind: 'notFound', domain, mx, dnsFailed };
  const imapServer: MailServer = imap;

  const hostPreset = findMailHostPreset({ host: imapServer.host }) ?? mxPreset;
  const hostEntry = registryByHost(registry, imapServer.host) ?? mxEntry;
  // Reaching DNS means a custom domain, so a Google mailbox here is Workspace.
  const workspace = hostPreset?.id === 'gmail';
  const entry = registryBySlug(
    registry,
    hostPreset ? (workspace ? 'google-workspace' : PRESET_SLUG[hostPreset.id]) : hostEntry?.slug,
  );
  return {
    kind: 'found',
    domain,
    label: (workspace ? entry?.name : null) ?? hostPreset?.label ?? hostEntry?.name ?? ispdbLabel,
    imap: imapServer,
    smtp,
    source,
    slug: entry?.slug ?? null,
    requiresAppPassword: hostPreset?.requiresAppPassword === true,
    appPasswordHelpUrl: hostPreset?.appPasswordHelpUrl ?? null,
    mx,
  };
}
