import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autodiscoverMailSettings,
  isPublicMailDomain,
  normalizeDomain,
  parseIspdb,
  presetFromMxRecords,
  serverFromSrv,
  SRV_SERVICES,
  type AutodiscoverDeps,
  type MxRecord,
  type SrvRecord,
} from './autodiscover.ts';

/**
 * Nothing here touches the network. The resolver is a table of canned answers
 * keyed by query name, and any name it has no answer for throws ENOTFOUND, the
 * way a real resolver does: "no records" and "no such name" have to be the
 * same outcome for this module or a domain with an MX and no SRV would fail
 * instead of falling through.
 */
function resolverFor(records: Record<string, SrvRecord[] | MxRecord[]>): AutodiscoverDeps {
  const answer = <T>(name: string): Promise<T> => {
    const found = records[name];
    if (!found) return Promise.reject(Object.assign(new Error('queryX ENOTFOUND'), { code: 'ENOTFOUND' }));
    return Promise.resolve(found as T);
  };
  return {
    resolveSrv: (name) => answer<SrvRecord[]>(name),
    resolveMx: (name) => answer<MxRecord[]>(`MX:${name}`),
  };
}

const srv = (name: string, port: number, priority = 0, weight = 1): SrvRecord => ({ name, port, priority, weight });

/* ── Domain validation ──────────────────────────────────────────────────── */

test('only public, multi-label DNS names are ever looked up', () => {
  for (const good of ['mcpemails.com', 'sub.example.co.uk', 'xn--bcher-kva.de', 'a-b.io']) {
    assert.equal(isPublicMailDomain(good), true, good);
  }
  const bad = [
    '',
    'localhost',
    'example',                 // single label: only resolvable via a search domain
    'mail.local',
    'db.internal',
    'thing.home.arpa',
    'anything.test',
    'host.invalid',
    'docs.example',           // RFC 2606 reserved, never a real mailbox
    '127.0.0.1',
    '2130706433',              // the same address as a bare integer
    '0177.0.0.1',              // octal
    '0x7f.0.0.1',              // hex
    '127.1',                   // inet_aton short form
    '::1',
    '[::ffff:127.0.0.1]',
    '10.0.0.7',
    '169.254.169.254',         // cloud instance metadata
    'exa mple.com',
    'under_score.com',
    'example.123',             // all-numeric TLD: a mistyped address literal
    'a..b.com',
  ];
  for (const value of bad) assert.equal(isPublicMailDomain(value), false, value);
});

test('a domain is normalised the way a resolver reads it', () => {
  assert.equal(normalizeDomain('  MCPEmails.COM.  '), 'mcpemails.com');
  assert.equal(normalizeDomain('[example.com]'), 'example.com');
  assert.equal(normalizeDomain(undefined), '');
});

/* ── RFC 6186 SRV ───────────────────────────────────────────────────────── */

test('an SRV record becomes a server, with the transport its label implies', () => {
  const imaps = SRV_SERVICES[0];
  const found = serverFromSrv([srv('imap.migadu.com.', 993)], imaps);
  assert.deepEqual(found, { host: 'imap.migadu.com', port: 993, security: 'tls', source: 'srv' });

  // _imap._tcp on 143 is the cleartext port that must be upgraded.
  const imap = SRV_SERVICES[1];
  assert.equal(serverFromSrv([srv('mail.example.com', 143)], imap)?.security, 'starttls');
});

test('a "." target means the service is not offered, not that DNS was silent', () => {
  // RFC 6186 §3. Read as an empty answer instead, this record would send the
  // caller on to the cleartext variant of a service the domain has just said
  // it does not run.
  assert.equal(serverFromSrv([srv('.', 993)], SRV_SERVICES[0]), null);
  assert.equal(serverFromSrv([], SRV_SERVICES[0]), null);
  assert.equal(serverFromSrv(null, SRV_SERVICES[0]), null);
});

test('the lowest priority wins, and weight breaks a tie', () => {
  const found = serverFromSrv(
    [srv('third.example.com', 993, 20, 10), srv('first.example.com', 993, 0, 1), srv('second.example.com', 993, 10, 5)],
    SRV_SERVICES[0]
  );
  assert.equal(found?.host, 'first.example.com');

  const tied = serverFromSrv(
    [srv('light.example.com', 993, 0, 1), srv('heavy.example.com', 993, 0, 50)],
    SRV_SERVICES[0]
  );
  assert.equal(tied?.host, 'heavy.example.com');
});

test('an SRV record that names something unreachable is discarded, not offered', () => {
  // The domain owner writes these records. A target that resolves inside our
  // own network, or a port outside the mail set, must never reach the form:
  // the connect route would refuse it anyway, and prefilling it would tell the
  // user we believe in a setting we are about to reject.
  assert.equal(serverFromSrv([srv('localhost', 993)], SRV_SERVICES[0]), null);
  assert.equal(serverFromSrv([srv('127.0.0.1', 993)], SRV_SERVICES[0]), null);
  assert.equal(serverFromSrv([srv('imap.example.com', 22)], SRV_SERVICES[0]), null);
  assert.equal(serverFromSrv([srv('imap.example.com', 465)], SRV_SERVICES[0]), null, 'an SMTP port is not an IMAP port');
  // The usable one out of a mixed set still wins.
  assert.equal(
    serverFromSrv([srv('localhost', 993, 0), srv('imap.example.com', 993, 10)], SRV_SERVICES[0])?.host,
    'imap.example.com'
  );
});

/* ── MX ─────────────────────────────────────────────────────────────────── */

test('an MX host is matched back against the preset table', () => {
  // Migadu, Zoho and Fastmail all publish MX names that already end in a
  // suffix the table lists, which is why most of the table needs no MX entry
  // of its own.
  assert.equal(
    presetFromMxRecords([{ exchange: 'aspmx2.migadu.com.', priority: 20 }, { exchange: 'aspmx1.migadu.com.', priority: 10 }])?.label,
    'Migadu'
  );
  assert.equal(presetFromMxRecords([{ exchange: 'mx.zoho.com', priority: 10 }])?.label, 'Zoho Mail');
  assert.equal(presetFromMxRecords([{ exchange: 'in1-smtp.messagingengine.com', priority: 10 }])?.label, 'Fastmail');
});

test('Google Workspace and iCloud custom domains are found through mxSuffixes', () => {
  // These two publish MX names that share nothing with their IMAP hosts
  // (checked live: stripe.com -> aspmx.l.google.com, icloud.com ->
  // mx01.mail.icloud.com), so they are the two entries that need the field.
  const google = presetFromMxRecords([
    { exchange: 'alt1.aspmx.l.google.com', priority: 20 },
    { exchange: 'aspmx.l.google.com', priority: 10 },
  ]);
  assert.equal(google?.imapHost, 'imap.gmail.com');
  assert.equal(google?.smtpHost, 'smtp.gmail.com');
  // The whole point for a Workspace mailbox: the account password will never
  // authenticate, and the form has to say so before the login is rejected.
  assert.equal(google?.requiresAppPassword, true);

  const apple = presetFromMxRecords([{ exchange: 'mx01.mail.icloud.com', priority: 10 }]);
  assert.equal(apple?.imapHost, 'imap.mail.me.com');
  assert.equal(apple?.requiresAppPassword, true);
});

test('the primary MX is preferred, and a relay in front of it is skipped', () => {
  // A filtering relay at priority 10 with the real provider behind it at 20 is
  // a common setup; taking only the first record would resolve to nothing.
  const found = presetFromMxRecords([
    { exchange: 'filter.unknown-relay.org', priority: 10 },
    { exchange: 'aspmx1.migadu.com', priority: 20 },
  ]);
  assert.equal(found?.label, 'Migadu');
});

test('an ambiguous MX resolves to the safer of the two entries it could be', () => {
  // OVH serves shared hosting and Hosted Exchange from the same mail.ovh.net,
  // and the two need different SMTP settings. The Exchange entry is excluded
  // from MX inference (mxAmbiguous), so the far more common shared-hosting
  // settings win rather than a hostname the customer does not have.
  const found = presetFromMxRecords([{ exchange: 'mx3.mail.ovh.net', priority: 1 }]);
  assert.equal(found?.label, 'OVH');
  assert.equal(found?.smtpHost, 'ssl0.ovh.net');
});

test('MX records that name nothing usable resolve to nothing', () => {
  assert.equal(presetFromMxRecords([]), null);
  assert.equal(presetFromMxRecords(null), null);
  assert.equal(presetFromMxRecords([{ exchange: 'localhost', priority: 1 }]), null);
  assert.equal(presetFromMxRecords([{ exchange: 'mail.some-host-we-do-not-know.org', priority: 1 }]), null);
});

/* ── Mozilla ISPDB ──────────────────────────────────────────────────────── */

const ISPDB_SAMPLE = `<?xml version="1.0"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <displayName>Example Mail</displayName>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

test('an ISPDB document yields both servers and the provider name', () => {
  const parsed = parseIspdb(ISPDB_SAMPLE);
  assert.deepEqual(parsed.imap, { host: 'imap.example.com', port: 993, security: 'tls', source: 'ispdb' });
  assert.deepEqual(parsed.smtp, { host: 'smtp.example.com', port: 587, security: 'starttls', source: 'ispdb' });
  assert.equal(parsed.label, 'Example Mail');
});

test('an ISPDB entry offering only cleartext is no answer at all', () => {
  // This product never dials a mail server in the clear, so "plain" is not a
  // setting to prefill; it is a provider we cannot serve.
  const plain = ISPDB_SAMPLE.replace('<socketType>SSL</socketType>', '<socketType>plain</socketType>')
    .replace('<port>993</port>', '<port>143</port>');
  assert.equal(parseIspdb(plain).imap, null);
});

test('a malformed or empty ISPDB response is silently nothing', () => {
  assert.deepEqual(parseIspdb(''), { imap: null, smtp: null, label: null });
  assert.deepEqual(parseIspdb('<html>404 not found</html>').imap, null);
});

/* ── The orchestrator ───────────────────────────────────────────────────── */

test('the static table answers first and costs no lookup', async () => {
  let queries = 0;
  const found = await autodiscoverMailSettings('gmx.net', {
    resolveSrv: async () => { queries += 1; return []; },
    resolveMx: async () => { queries += 1; return []; },
  });
  assert.equal(found?.source, 'table');
  assert.equal(found?.label, 'GMX');
  assert.equal(queries, 0, 'a domain the table knows must not reach the resolver');
});

test('hello@mcpemails.com resolves end to end from the domain’s SRV records', async () => {
  // The exact records the domain publishes, checked with dig on 2026-09-08:
  //   _imaps._tcp.mcpemails.com       0 1 993 imap.migadu.com.
  //   _submissions._tcp.mcpemails.com 0 1 465 smtp.migadu.com.
  // The static table cannot answer this (mcpemails.com is nowhere in it) and
  // the Mozilla ISPDB 404s it, so SRV is the source, and the provider name
  // then falls out of matching imap.migadu.com against the table.
  const found = await autodiscoverMailSettings('mcpemails.com', resolverFor({
    '_imaps._tcp.mcpemails.com': [srv('imap.migadu.com.', 993)],
    '_submissions._tcp.mcpemails.com': [srv('smtp.migadu.com.', 465)],
    'MX:mcpemails.com': [{ exchange: 'aspmx1.migadu.com.', priority: 10 }, { exchange: 'aspmx2.migadu.com.', priority: 20 }],
  }));
  assert.equal(found?.source, 'srv');
  assert.equal(found?.label, 'Migadu');
  assert.equal(found?.imapHost, 'imap.migadu.com');
  assert.equal(found?.imapPort, 993);
  assert.equal(found?.imapSecurity, 'tls');
  assert.equal(found?.smtpHost, 'smtp.migadu.com');
  assert.equal(found?.smtpPort, 465);
  assert.equal(found?.smtpSecurity, 'tls');
});

test('a domain with only an MX still resolves, through the table', async () => {
  const found = await autodiscoverMailSettings('some-agency.co', resolverFor({
    'MX:some-agency.co': [{ exchange: 'aspmx.l.google.com', priority: 1 }],
  }));
  assert.equal(found?.source, 'mx');
  assert.equal(found?.label, 'Gmail');
  assert.equal(found?.imapHost, 'imap.gmail.com');
  assert.equal(found?.requiresAppPassword, true);
});

test('a half answer from SRV is completed from the MX rather than guessed at', async () => {
  const found = await autodiscoverMailSettings('half-answer.org', resolverFor({
    '_imaps._tcp.half-answer.org': [srv('imap.migadu.com', 993)],
    'MX:half-answer.org': [{ exchange: 'aspmx1.migadu.com', priority: 10 }],
  }));
  assert.equal(found?.imapHost, 'imap.migadu.com');
  assert.equal(found?.smtpHost, 'smtp.migadu.com');
  // The incoming half is what names the source, and it came from SRV.
  assert.equal(found?.source, 'srv');
});

test('half an answer and nothing to complete it returns nothing', async () => {
  // A form with an IMAP host and an empty SMTP host is worse than an empty
  // form: the user cannot tell which half was a guess.
  const found = await autodiscoverMailSettings('lonely-domain.org', resolverFor({
    '_imaps._tcp.lonely-domain.org': [srv('imap.lonely-domain.org', 993)],
  }));
  assert.equal(found, null);
});

test('the ISPDB is asked last, and only when DNS has said nothing', async () => {
  const asked: string[] = [];
  const deps: AutodiscoverDeps = {
    ...resolverFor({ '_imaps._tcp.known-domain.org': [srv('imap.migadu.com', 993)], '_submissions._tcp.known-domain.org': [srv('smtp.migadu.com', 465)] }),
    fetchIspdb: async (url) => { asked.push(url); return ISPDB_SAMPLE; },
  };
  await autodiscoverMailSettings('known-domain.org', deps);
  assert.equal(asked.length, 0, 'DNS answered in full, so there was nothing to ask the ISPDB');

  const fallback = await autodiscoverMailSettings('unknown-domain.org', {
    ...resolverFor({}),
    fetchIspdb: async (url) => { asked.push(url); return ISPDB_SAMPLE; },
  });
  assert.deepEqual([...asked], ['https://autoconfig.thunderbird.net/v1.1/unknown-domain.org']);
  assert.equal(fallback?.source, 'ispdb');
  assert.equal(fallback?.imapHost, 'imap.example.com');
  assert.equal(fallback?.label, 'Example Mail');
});

test('a domain we will not resolve is refused before any lookup', async () => {
  for (const domain of ['localhost', '169.254.169.254', 'db.internal', '']) {
    let touched = false;
    const found = await autodiscoverMailSettings(domain, {
      resolveSrv: async () => { touched = true; return []; },
      resolveMx: async () => { touched = true; return []; },
      fetchIspdb: async () => { touched = true; return null; },
    });
    assert.equal(found, null, domain);
    assert.equal(touched, false, `${domain} reached the resolver`);
  }
});

test('a resolver that throws is the same as a resolver that found nothing', async () => {
  // Every DNS failure mode arrives as an exception (ENOTFOUND, SERVFAIL,
  // ETIMEOUT) and none of them is an error the user can act on, so none of
  // them may propagate out of a lookup the user did not ask for.
  const found = await autodiscoverMailSettings('broken-domain.org', {
    resolveSrv: async () => { throw new Error('SERVFAIL'); },
    resolveMx: async () => { throw new Error('ETIMEOUT'); },
    fetchIspdb: async () => { throw new Error('network'); },
  });
  assert.equal(found, null);
});
