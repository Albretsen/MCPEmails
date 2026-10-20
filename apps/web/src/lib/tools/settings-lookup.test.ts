// Run with: node --test --experimental-strip-types src/lib/tools/settings-lookup.test.ts
//
// The lookup behind /tools/email-settings-lookup, with DNS over HTTPS and the
// ISPDB stubbed: no test here touches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOH_ORIGIN,
  ISPDB_ORIGIN,
  lookupMailSettings,
  parseIspdb,
  parseLookupInput,
  parseMx,
  parseSrv,
  registrableDomain,
  type Fetcher,
  type RegistryEntry,
} from './settings-lookup.ts';

const REGISTRY: RegistryEntry[] = [
  {
    slug: 'gmx', name: 'GMX', domain: 'gmx.net', status: 'supported', locales: ['en'],
    imap: { host: 'imap.gmx.net', port: 993, security: 'tls' },
    smtp: { host: 'mail.gmx.net', port: 465, security: 'tls' },
  },
  {
    slug: 'aol', name: 'AOL Mail', domain: 'aol.com', status: 'supported', locales: ['en'],
    imap: { host: 'imap.aol.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' },
  },
  {
    slug: 'verizon', name: 'Verizon', domain: 'verizon.net', status: 'supported', locales: ['en'],
    imap: { host: 'imap.aol.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' },
  },
  {
    slug: 'purelymail', name: 'Purelymail', domain: 'purelymail.com', status: 'supported', locales: ['en'],
    imap: { host: 'imap.purelymail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.purelymail.com', port: 465, security: 'tls' },
  },
  { slug: 'migadu', name: 'Migadu', domain: 'migadu.com', status: 'supported', locales: ['en'],
    imap: { host: 'imap.migadu.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.migadu.com', port: 465, security: 'tls' } },
  { slug: 'ovh', name: 'OVH', domain: 'ovh.net', status: 'supported', locales: ['en'],
    imap: { host: 'ssl0.ovh.net', port: 993, security: 'tls' },
    smtp: { host: 'ssl0.ovh.net', port: 465, security: 'tls' } },
  { slug: 'gmail', name: 'Gmail', domain: 'gmail.com', status: 'supported', locales: ['en'], imap: null, smtp: null },
  { slug: 'google-workspace', name: 'Google Workspace', domain: 'workspace.google.com', status: 'supported', locales: ['en'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } },
  { slug: 'proton', name: 'Proton Mail', domain: 'protonmail.com', status: 'limited', locales: ['en'], imap: null, smtp: null },
  { slug: 'office365', name: 'Microsoft 365', domain: 'office365.com', status: 'supported', locales: ['en'], imap: null, smtp: null },
];

/** A fetch that answers DoH from `dns` ({"MX example.com": ["10 mx.example.net."]}) and the ISPDB from `ispdb`. */
function stubFetch(dns: Record<string, string[]>, ispdb: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (url.startsWith(DOH_ORIGIN)) {
      const u = new URL(url);
      const type = u.searchParams.get('type') as 'MX' | 'SRV';
      const data = dns[`${type} ${u.searchParams.get('name')}`];
      const body = data
        ? { Status: 0, Answer: data.map((d) => ({ type: type === 'MX' ? 15 : 33, data: d })) }
        : { Status: 3 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.startsWith(ISPDB_ORIGIN)) {
      const xml = ispdb[decodeURIComponent(url.slice(ISPDB_ORIGIN.length))];
      return new Response(xml ?? 'not found', { status: xml ? 200 : 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetcher, calls };
}

const run = (q: string, dns: Record<string, string[]> = {}, ispdb: Record<string, string> = {}) => {
  const { fetcher, calls } = stubFetch(dns, ispdb);
  return lookupMailSettings(q, { registry: REGISTRY, fetch: fetcher }).then((r) => ({ r, calls }));
};

test('parseLookupInput takes an address, a domain or a host, and rejects the rest', () => {
  assert.deepEqual(parseLookupInput('  Me@Example.COM '), { domain: 'example.com', isAddress: true });
  assert.deepEqual(parseLookupInput('ex4.mail.ovh.net'), { domain: 'ex4.mail.ovh.net', isAddress: false });
  assert.deepEqual(parseLookupInput('https://example.com/path'), { domain: 'example.com', isAddress: false });
  assert.deepEqual(parseLookupInput('imap.example.com:993'), { domain: 'imap.example.com', isAddress: false });
  assert.equal(parseLookupInput('müller.de')?.domain, 'xn--mller-kva.de');
  for (const bad of ['', 'localhost', 'me@', '127.0.0.1', '[::1]', 'not an email', 'a_b.com']) {
    assert.equal(parseLookupInput(bad), null, bad);
  }
});

test('registrableDomain keeps country second-level names together', () => {
  assert.equal(registrableDomain('mailserver.purelymail.com'), 'purelymail.com');
  assert.equal(registrableDomain('mx.foo.co.uk'), 'foo.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('parseMx orders by preference and drops duplicates', () => {
  assert.deepEqual(parseMx(['20 b.example.net.', '10 a.example.net.', '30 a.example.net.']), ['a.example.net', 'b.example.net']);
});

test('parseSrv honours "." and the port allowlist', () => {
  assert.deepEqual(parseSrv(['0 1 993 imap.example.net.'], 'imap', 'tls'), { host: 'imap.example.net', port: 993, security: 'tls' });
  assert.equal(parseSrv(['0 0 0 .'], 'imap', 'tls'), null);
  assert.equal(parseSrv(['0 1 2525 smtp.example.net.'], 'smtp', 'tls'), null);
  assert.equal(parseSrv(['10 1 465 b.example.net', '0 1 465 a.example.net'], 'smtp', 'tls')?.host, 'a.example.net');
});

test('parseIspdb ignores plaintext servers', () => {
  const xml = `<clientConfig><emailProvider id="x"><displayName>Example Mail</displayName>
    <incomingServer type="imap"><hostname>imap.example.net</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.example.net</hostname><port>25</port><socketType>plain</socketType></outgoingServer>
  </emailProvider></clientConfig>`;
  const parsed = parseIspdb(xml);
  assert.equal(parsed.imap?.host, 'imap.example.net');
  assert.equal(parsed.smtp, null);
  assert.equal(parsed.label, 'Example Mail');
});

test('a provider address is answered from the registry, with no network', async () => {
  const { r, calls } = await run('someone@gmx.net');
  assert.equal(r.kind, 'found');
  if (r.kind !== 'found') return;
  assert.equal(r.source, 'registry');
  assert.equal(r.slug, 'gmx');
  assert.equal(r.smtp.host, 'mail.gmx.net');
  assert.equal(calls.length, 0);
});

test('Verizon resolves to its own page, not AOL, though the hosts are shared', async () => {
  const { r } = await run('x@verizon.net');
  assert.equal(r.kind === 'found' && r.slug, 'verizon');
});

test('a typed OVH Exchange host keeps its cluster number and gets 587 STARTTLS', async () => {
  const { r, calls } = await run('ex4.mail.ovh.net');
  assert.equal(r.kind, 'found');
  if (r.kind !== 'found') return;
  assert.equal(r.imap.host, 'ex4.mail.ovh.net');
  assert.deepEqual(r.smtp, { host: 'ex4.mail.ovh.net', port: 587, security: 'starttls' });
  assert.equal(r.slug, 'ovh');
  assert.equal(calls.length, 0);
});

test('a typed OVH MX name is shared hosting, not Exchange', async () => {
  const { r } = await run('mx1.mail.ovh.net');
  assert.equal(r.kind === 'found' && r.imap.host, 'ssl0.ovh.net');
});

test('Gmail addresses use the table and link the Gmail page', async () => {
  const { r } = await run('me@gmail.com');
  assert.equal(r.kind === 'found' && r.slug, 'gmail');
  assert.equal(r.kind === 'found' && r.requiresAppPassword, true);
});

test('personal Microsoft accounts get no IMAP settings', async () => {
  const { r, calls } = await run('me@hotmail.com');
  assert.deepEqual(r, { kind: 'microsoft', domain: 'hotmail.com', slug: 'outlook', mx: [] });
  assert.equal(calls.length, 0);
});

test('a Microsoft 365 MX is reported as Microsoft 365', async () => {
  const { r } = await run('me@contoso-example.com', { 'MX contoso-example.com': ['0 contoso-example-com.mail.protection.outlook.com.'] });
  assert.equal(r.kind === 'microsoft' && r.slug, 'office365');
});

test('Proton is limited by address and by MX', async () => {
  assert.equal((await run('me@proton.me')).r.kind, 'limited');
  const { r } = await run('me@mine.example', { 'MX mine.example': ['10 mail.protonmail.ch.'] });
  assert.equal(r.kind === 'limited' && r.slug, 'proton');
});

test('SRV records win, and the provider is named from the IMAP host', async () => {
  const { r } = await run('hello@shop.example', {
    'SRV _imaps._tcp.shop.example': ['0 1 993 imap.migadu.com.'],
    'SRV _submissions._tcp.shop.example': ['0 1 465 smtp.migadu.com.'],
    'MX shop.example': ['10 aspmx1.migadu.com.'],
  });
  assert.equal(r.kind, 'found');
  if (r.kind !== 'found') return;
  assert.equal(r.source, 'srv');
  assert.equal(r.label, 'Migadu');
  assert.equal(r.slug, 'migadu');
  assert.deepEqual(r.mx, ['aspmx1.migadu.com']);
});

test('a Google MX on a custom domain is Google Workspace', async () => {
  const { r } = await run('me@firm.example', { 'MX firm.example': ['1 aspmx.l.google.com.', '5 alt1.aspmx.l.google.com.'] });
  assert.equal(r.kind, 'found');
  if (r.kind !== 'found') return;
  assert.equal(r.source, 'mx');
  assert.equal(r.slug, 'google-workspace');
  assert.equal(r.label, 'Google Workspace');
  assert.equal(r.imap.host, 'imap.gmail.com');
});

test('an MX the table does not know is matched to the registry by its domain', async () => {
  const { r } = await run('me@pm-customer.example', { 'MX pm-customer.example': ['50 mailserver.purelymail.com.'] });
  assert.equal(r.kind === 'found' && r.slug, 'purelymail');
  assert.equal(r.kind === 'found' && r.smtp.host, 'smtp.purelymail.com');
});

test('the ISPDB is the last resort, and only both halves count', async () => {
  const xml = `<incomingServer type="imap"><hostname>imap.isp.example</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
    <outgoingServer type="smtp"><hostname>smtp.isp.example</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>`;
  const { r } = await run('me@isp.example', {}, { 'isp.example': xml });
  assert.equal(r.kind === 'found' && r.source, 'ispdb');
  assert.equal(r.kind === 'found' && r.slug, null);

  const half = `<incomingServer type="imap"><hostname>imap.isp.example</hostname><port>993</port><socketType>SSL</socketType></incomingServer>`;
  assert.equal((await run('me@isp.example', {}, { 'isp.example': half })).r.kind, 'notFound');
});

test('nothing found still reports the MX hosts', async () => {
  const { r } = await run('me@filtered.example', { 'MX filtered.example': ['10 mx.filter-vendor.example.'] });
  assert.deepEqual(r, { kind: 'notFound', domain: 'filtered.example', mx: ['mx.filter-vendor.example'], dnsFailed: false });
});

test('a domain with no MX is reported as such, not as a DNS failure', async () => {
  const { r } = await run('me@nomx.example');
  assert.deepEqual(r, { kind: 'notFound', domain: 'nomx.example', mx: [], dnsFailed: false });
});

test('a failing network is not reported as "no MX records"', async () => {
  const r = await lookupMailSettings('me@down.example', {
    registry: REGISTRY,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  assert.deepEqual(r, { kind: 'notFound', domain: 'down.example', mx: [], dnsFailed: true });
});

test('SERVFAIL is a DNS failure too', async () => {
  const r = await lookupMailSettings('me@broken.example', {
    registry: REGISTRY,
    fetch: async (url) => url.startsWith(DOH_ORIGIN)
      ? new Response(JSON.stringify({ Status: 2 }), { status: 200 })
      : new Response('not found', { status: 404 }),
  });
  assert.equal(r.kind === 'notFound' && r.dnsFailed, true);
});

test('the domain only ever reaches the two fixed origins', async () => {
  const { calls } = await run('me@x.example');
  assert.ok(calls.length > 0);
  for (const url of calls) assert.ok(url.startsWith(DOH_ORIGIN) || url.startsWith(ISPDB_ORIGIN), url);
});
