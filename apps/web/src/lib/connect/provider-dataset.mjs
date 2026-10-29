import { releasedProviders } from './release.mjs';

/**
 * The open dataset behind /docs/providers/data and its JSON and CSV downloads.
 *
 * Everything here is derived from PROVIDERS in providers.mjs at request time,
 * so the page, the downloads and the /connect pages can never disagree. Nothing
 * here may come from a database table: the dataset is what a TLS probe of a
 * public mail server returned, and a field derived from customers' mailboxes
 * (relay hosts, error rates, connection counts) would turn it into a list of
 * who uses which provider.
 *
 * What is published, and why only this
 * ------------------------------------
 * The 2026-08-31 probe opened a TLS connection, read the IMAP greeting and
 * CAPABILITY, and sent SMTP EHLO. It never logged in. That makes the AUTH=
 * mechanisms, SASL-IR and the SMTP SIZE limit reliable: servers advertise them
 * before login by design. It makes MOVE, IDLE, UIDPLUS and SPECIAL-USE
 * unreliable: Dovecot and iCloud list those only after login, so the probe
 * records `false` for servers that do support them. Those four fields are
 * therefore left out of the dataset entirely rather than shipped with a caveat
 * nobody reads. The raw `banner` is left out too: some greetings echo the
 * connecting client's address back.
 *
 * SMTP on a STARTTLS port (587) advertises AUTH only after STARTTLS, so an
 * empty mechanism list there means "not visible before TLS", not "no auth".
 * Those rows carry `null`, never `[]`.
 */

export const DATASET_PATH = '/docs/providers/data';
export const JSON_PATH = '/data/imap-providers.json';
export const CSV_PATH = '/data/imap-providers.csv';
export const SCHEMA_VERSION = 1;
export const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

const MB = 1024 * 1024;

/** One row per released provider whose servers answered the probe. */
export function datasetRows(now = new Date()) {
  return releasedProviders(now)
    .filter((p) => p.evidence?.reachable && p.imap)
    .map((p) => {
      const e = p.evidence;
      const smtpAuthVisible = !(p.smtp?.security === 'starttls' && e.smtpAuthMechs.length === 0);
      const size = Number(e.smtpMaxSize);
      return {
        slug: p.slug,
        name: p.name,
        domain: p.domain,
        category: p.category,
        imapHost: p.imap.host,
        imapPort: p.imap.port,
        imapSecurity: p.imap.security,
        imapAuth: [...e.authMechs].sort(),
        saslIr: e.saslIr,
        smtpHost: p.smtp?.host ?? null,
        smtpPort: p.smtp?.port ?? null,
        smtpSecurity: p.smtp?.security ?? null,
        smtpAuth: p.smtp && smtpAuthVisible ? [...e.smtpAuthMechs].sort() : null,
        smtpMaxSizeMb: size > 0 ? Math.round((size / MB) * 10) / 10 : null,
        oauthAdvertised: e.authMechs.some((m) => m === 'XOAUTH2' || m === 'OAUTHBEARER'),
        settingsSource: p.source,
        probedOn: e.verifiedOn,
        page: `/connect/${p.slug}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Headline figures, computed so the prose can never drift from the table. */
export function datasetStats(rows = datasetRows()) {
  const sizes = rows.map((r) => r.smtpMaxSizeMb).filter((n) => n != null).sort((a, b) => a - b);
  const count = (f) => rows.filter(f).length;
  return {
    providers: rows.length,
    noSaslIr: count((r) => r.saslIr === false),
    oauth: count((r) => r.oauthAdvertised),
    plain: count((r) => r.imapAuth.includes('PLAIN')),
    loginOnly: count((r) => r.imapAuth.includes('LOGIN') && !r.imapAuth.includes('PLAIN')),
    implicitTlsSmtp: count((r) => r.smtpSecurity === 'tls'),
    starttlsSmtp: count((r) => r.smtpSecurity === 'starttls'),
    sizeCount: sizes.length,
    sizeMin: sizes[0] ?? null,
    sizeMax: sizes.at(-1) ?? null,
    sizeMedian: median(sizes),
    probedOn: rows.map((r) => r.probedOn).sort().at(-1) ?? null,
  };
}

export function datasetJson(appUrl) {
  const rows = datasetRows();
  return {
    schemaVersion: SCHEMA_VERSION,
    title: 'IMAP and SMTP provider compatibility dataset',
    description:
      'Connection settings and pre-login capabilities of public mail providers, read from a live TLS probe.',
    publisher: 'MCPEmails',
    homepage: `${appUrl}${DATASET_PATH}`,
    license: LICENSE_URL,
    probedOn: datasetStats(rows).probedOn,
    method:
      'TLS handshake validated against the hostname, then IMAP CAPABILITY and SMTP EHLO. No login, no mail read.',
    fields: FIELD_DOCS.map(({ key, doc }) => ({ key, doc })),
    providers: rows.map((r) => ({ ...r, page: `${appUrl}${r.page}` })),
  };
}

const csvCell = (v) => {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join(' ') : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function datasetCsv(appUrl) {
  const keys = FIELD_DOCS.map((f) => f.key);
  const lines = [keys.join(',')];
  for (const r of datasetRows()) {
    lines.push(keys.map((k) => csvCell(k === 'page' ? `${appUrl}${r.page}` : r[k])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** Column documentation, shared by the page, the JSON and the CSV header order. */
export const FIELD_DOCS = [
  { key: 'slug', doc: 'Stable identifier, also the /connect/<slug> page.' },
  { key: 'name', doc: 'Provider name.' },
  { key: 'domain', doc: 'Main consumer address domain, or empty for hosts that serve your own domain.' },
  { key: 'category', doc: 'consumer, business, hosting, cpanel, privacy, isp, regional or selfhost.' },
  { key: 'imapHost', doc: 'IMAP server hostname. The certificate was validated against it.' },
  { key: 'imapPort', doc: 'IMAP port.' },
  { key: 'imapSecurity', doc: 'tls (implicit TLS) or starttls.' },
  { key: 'imapAuth', doc: 'SASL mechanisms the IMAP server advertises before login (AUTH=).' },
  { key: 'saslIr', doc: 'Whether the server advertises SASL-IR (credentials sent with the AUTHENTICATE command in one round trip).' },
  { key: 'smtpHost', doc: 'SMTP submission hostname.' },
  { key: 'smtpPort', doc: 'SMTP submission port.' },
  { key: 'smtpSecurity', doc: 'tls (implicit TLS) or starttls.' },
  { key: 'smtpAuth', doc: 'SASL mechanisms in the EHLO reply. Empty when the server only lists them after STARTTLS.' },
  { key: 'smtpMaxSizeMb', doc: 'SMTP SIZE limit in MiB, for the whole encoded message. Attachments grow by about a third in base64.' },
  { key: 'oauthAdvertised', doc: 'Whether IMAP advertises XOAUTH2 or OAUTHBEARER. Advertised is not the same as open to third-party apps.' },
  { key: 'settingsSource', doc: 'Where the hosts and ports came from: ispdb+probe (Thunderbird ISPDB) or vendor+probe (vendor documentation).' },
  { key: 'probedOn', doc: 'Date of the probe (YYYY-MM-DD).' },
  { key: 'page', doc: 'Setup guide for connecting this provider to an AI assistant.' },
];
