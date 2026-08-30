import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guardMailHost,
  isAllowedMailPort,
  normalizeMailHost,
  parseIpv6,
  parseLooseIpv4,
  type HostLookup,
} from './host-guard.ts';

/**
 * No test in this file touches the network. Every hostname case goes through an
 * injected `lookup`, which is also the only honest way to test the rule that
 * matters most: a perfectly ordinary-looking name whose A record points inside.
 */
function lookupReturning(...addresses: string[]): HostLookup {
  return async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

const lookupFails: HostLookup = async () => {
  const error = new Error('getaddrinfo ENOTFOUND') as NodeJS.ErrnoException;
  error.code = 'ENOTFOUND';
  throw error;
};

/** Shorthand: a public A record, so only the host string is under test. */
const publicLookup = lookupReturning('142.250.74.101');

async function guard(host: string, port = 993, protocol: 'imap' | 'smtp' = 'imap', lookup: HostLookup = publicLookup) {
  return guardMailHost(host, { protocol, port, lookup });
}

/* ── IPv4 literals ──────────────────────────────────────────────────────── */

test('every blocked IPv4 range is refused as a literal', async () => {
  const blocked = [
    '0.0.0.0',            // unspecified; a live alias for localhost on Linux
    '127.0.0.1',          // loopback
    '127.1.2.3',          // the whole /8, not just .0.0.1
    '169.254.169.254',    // cloud instance metadata, the prize target
    '169.254.1.1',        // the rest of link-local
    '10.0.0.7',           // RFC 1918
    '172.16.0.1',         // RFC 1918, low edge of the /12
    '172.31.255.254',     // RFC 1918, high edge of the /12
    '192.168.1.1',        // RFC 1918
    '100.64.0.1',         // CGNAT
    '100.127.255.255',    // CGNAT, high edge of the /10
    '224.0.0.1',          // multicast
    '239.255.255.250',    // multicast (SSDP)
    '255.255.255.255',    // broadcast
    '240.0.0.1',          // reserved
    '192.0.2.1',          // TEST-NET-1
    '198.18.0.1',         // benchmarking
    '192.88.99.1',        // 6to4 relay anycast
  ];
  for (const host of blocked) {
    const result = await guard(host);
    assert.equal(result.ok, false, `${host} must be refused`);
    assert.equal(result.ok === false && result.code, 'host_not_allowed', host);
  }
});

test('the neighbours of each blocked range still pass', async () => {
  // 172.15/172.32 and 100.63/100.128 are the off-by-one mistakes a hand-rolled
  // mask check makes, and they are public address space.
  for (const host of ['172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '126.255.255.255', '128.0.0.1']) {
    const result = await guard(host);
    assert.equal(result.ok, true, `${host} is public and must pass`);
  }
});

test('IPv4 encoding tricks resolve to the same blocked address', async () => {
  // Each of these is 127.0.0.1 to getaddrinfo. A guard that only understands
  // the dotted-quad form lets all four through.
  for (const host of ['2130706433', '0177.0.0.1', '0x7f.0.0.1', '0x7f000001', '127.1', '127.0.1', '017700000001']) {
    const result = await guard(host);
    assert.equal(result.ok, false, `${host} must be refused`);
    assert.equal(result.ok === false && result.code, 'host_not_allowed', host);
  }
  // And the metadata address in decimal.
  const metadata = await guard('2852039166');
  assert.equal(metadata.ok, false);
  assert.equal(metadata.ok === false && metadata.code, 'host_not_allowed');
});

test('a trailing dot does not smuggle a literal past the check', async () => {
  // `127.0.0.1.` is the same destination to the resolver, and the extra dot was
  // enough to make a string comparison miss.
  for (const host of ['127.0.0.1.', '169.254.169.254.', '10.0.0.1.']) {
    const result = await guard(host);
    assert.equal(result.ok, false, `${host} must be refused`);
    assert.equal(result.ok === false && result.code, 'host_not_allowed', host);
  }
});

test('parseLooseIpv4 reads inet_aton forms and rejects names', () => {
  assert.equal(parseLooseIpv4('127.0.0.1'), 2130706433);
  assert.equal(parseLooseIpv4('2130706433'), 2130706433);
  assert.equal(parseLooseIpv4('0177.0.0.1'), 2130706433);
  assert.equal(parseLooseIpv4('0x7f.0.0.1'), 2130706433);
  assert.equal(parseLooseIpv4('255.255.255.255'), 4294967295);
  assert.equal(parseLooseIpv4('imap.gmail.com'), null);
  assert.equal(parseLooseIpv4('256.0.0.1'), null);
  assert.equal(parseLooseIpv4('1.2.3.4.5'), null);
  assert.equal(parseLooseIpv4('0x100000000'), null, 'must not overflow 32 bits');
  assert.equal(parseLooseIpv4('09.0.0.1'), null, 'a leading zero means octal, and 9 is not an octal digit');
});

/* ── IPv6 literals ──────────────────────────────────────────────────────── */

test('every blocked IPv6 form is refused', async () => {
  const blocked = [
    '::1',                    // loopback
    '::',                     // unspecified
    '[::1]',                  // bracketed, as a pasted URL authority arrives
    'fe80::1',                // link-local
    'fe80::1%eth0',           // link-local with a zone id
    'febf::1',                // still inside fe80::/10
    'fc00::1',                // unique local
    'fd12:3456::1',           // unique local, the half people actually use
    'ff02::1',                // multicast
    '2001:db8::1',            // documentation
    '2001:0:1234::1',         // Teredo
    '::ffff:127.0.0.1',       // IPv4-mapped loopback — the classic bypass
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:10.0.0.1',        // IPv4-mapped RFC 1918
    '::127.0.0.1',            // deprecated IPv4-compatible loopback
    '2002:7f00:1::1',         // 6to4 wrapping 127.0.0.1, inside global unicast
    '2002:a9fe:a9fe::1',      // 6to4 wrapping 169.254.169.254
    '64:ff9b::127.0.0.1',     // NAT64 wrapping loopback
  ];
  for (const host of blocked) {
    const result = await guard(host);
    assert.equal(result.ok, false, `${host} must be refused`);
    assert.equal(result.ok === false && result.code, 'host_not_allowed', host);
  }
});

test('public IPv6 and IPv4-mapped-public still pass, and mapped forms pin as IPv4', async () => {
  const global = await guard('2a00:1450:400f:80d::2005');
  assert.equal(global.ok, true);
  assert.equal(global.ok === true && global.family, 6);

  const mapped = await guard('::ffff:8.8.8.8');
  assert.equal(mapped.ok, true);
  // Rendered as the address it actually names, so the socket lands on the right
  // family and the pinned value is readable.
  assert.equal(mapped.ok === true && mapped.address, '8.8.8.8');
  assert.equal(mapped.ok === true && mapped.family, 4);
});

test('parseIpv6 places bytes correctly and rejects malformed literals', () => {
  assert.deepEqual(Array.from(parseIpv6('::1') ?? []), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(parseIpv6('::ffff:127.0.0.1') ?? []).slice(10), [0xff, 0xff, 127, 0, 0, 1]);
  assert.deepEqual(Array.from(parseIpv6('1:2:3:4:5:6:7:8') ?? []).slice(0, 4), [0, 1, 0, 2]);
  assert.equal(parseIpv6('1:2:3:4:5:6:7'), null, 'seven groups without an elision is short');
  assert.equal(parseIpv6('1:2:3:4:5:6:7:8:9'), null, 'nine groups is long');
  assert.equal(parseIpv6('1::2::3'), null, 'two elisions are ambiguous');
  assert.equal(parseIpv6('1:2:3:4:5:6:7:8::'), null, 'an elision must cover at least one group');
  assert.equal(parseIpv6('::gggg'), null);
  assert.equal(parseIpv6('::ffff:0177.0.0.1'), null, 'the embedded quad is strict-form only');
  assert.equal(parseIpv6('imap.gmail.com'), null);
});

/* ── Hostnames ──────────────────────────────────────────────────────────── */

test('the mail hosts real customers use still pass', async () => {
  for (const host of ['imap.gmail.com', 'imap.fastmail.com', 'mail.domeneshop.no', 'smtp.office365.com', 'imappro.zoho.eu']) {
    const result = await guard(host);
    assert.equal(result.ok, true, `${host} must pass`);
    assert.equal(result.ok === true && result.address, '142.250.74.101', 'the approved address is what gets pinned');
    assert.equal(result.ok === true && result.host, host, 'the name survives for TLS SNI');
  }
});

test('a syntactically hostile host string never reaches DNS', async () => {
  // If any of these got as far as the resolver the injected lookup would answer
  // with a public address and the assertion below would fail.
  const hostile = [
    'localhost',                       // single label; only resolvable internally
    'imap.gmail.com:993',              // a port smuggled into the host field
    'user@169.254.169.254',            // userinfo
    'imap.gmail.com/../metadata',      // a path
    'imap gmail com',                  // whitespace
    'imap.gmail.com\\@evil.example',   // backslash confusion
    '-imap.gmail.com',                 // a label may not start with a hyphen
    'imap..gmail.com',                 // empty label
    '',                                // empty
    'imap.gmail.com#x',                // fragment
  ];
  for (const host of hostile) {
    const result = await guard(host);
    assert.equal(result.ok, false, `${host} must be refused`);
    assert.equal(result.ok === false && result.code, 'host_invalid', host);
  }
});

test('a public-looking name whose A record points inside is refused', async () => {
  // This is the actual attack. The string is a perfectly ordinary hostname; the
  // only thing wrong with it is the answer DNS gives.
  for (const address of ['169.254.169.254', '127.0.0.1', '10.1.2.3', '192.168.0.5', '::1', 'fd00::1']) {
    const result = await guard('mail.attacker.example', 993, 'imap', lookupReturning(address));
    assert.equal(result.ok, false, `A record ${address} must be refused`);
    assert.equal(result.ok === false && result.code, 'host_not_allowed', address);
  }
});

test('one bad answer among good ones poisons the whole name', async () => {
  // A rebinding setup staged inside a single response. There is no legitimate
  // mail host that answers with a public address and a loopback address.
  const result = await guard('mail.attacker.example', 993, 'imap', lookupReturning('142.250.74.101', '127.0.0.1'));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'host_not_allowed');
});

test('a name that does not resolve reports host_not_found, not a block', async () => {
  // The distinction matters to the user: "typo" and "we refuse to go there" are
  // different problems with different fixes.
  const failed = await guard('mail.nonexistent.example', 993, 'imap', lookupFails);
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.code, 'host_not_found');

  const empty = await guard('mail.nonexistent.example', 993, 'imap', lookupReturning());
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.code, 'host_not_found');
});

test('IPv4 is preferred when a dual-stack name offers both', async () => {
  // Our egress is IPv4; pinning the AAAA on a dual-stack host would start
  // failing connections that work today.
  const result = await guard('imap.gmail.com', 993, 'imap', lookupReturning('2a00:1450:400f::2005', '142.250.74.101'));
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.address, '142.250.74.101');
  assert.equal(result.ok === true && result.family, 4);
});

test('an IPv6-only name still pins its AAAA', async () => {
  const result = await guard('imap.example.com', 993, 'imap', lookupReturning('2a00:1450:400f::2005'));
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.family, 6);
});

/* ── Ports ──────────────────────────────────────────────────────────────── */

test('only the mail ports are allowed, per protocol', () => {
  assert.equal(isAllowedMailPort('imap', 993), true);
  assert.equal(isAllowedMailPort('imap', 143), true);
  assert.equal(isAllowedMailPort('smtp', 465), true);
  assert.equal(isAllowedMailPort('smtp', 587), true);
  assert.equal(isAllowedMailPort('smtp', 25), true);

  // Cross-protocol: an IMAP field must not accept a submission port and back.
  assert.equal(isAllowedMailPort('imap', 587), false);
  assert.equal(isAllowedMailPort('smtp', 993), false);

  // The scanning targets.
  for (const port of [22, 80, 443, 3306, 5432, 6379, 8080, 9200, 11211, 1, 65535]) {
    assert.equal(isAllowedMailPort('imap', port), false, `imap ${port}`);
    assert.equal(isAllowedMailPort('smtp', port), false, `smtp ${port}`);
  }
  assert.equal(isAllowedMailPort('imap', 993.5), false);
  assert.equal(isAllowedMailPort('imap', Number.NaN), false);
  assert.equal(isAllowedMailPort('imap', '993'), false);
});

test('a rejected port short-circuits before any resolution happens', async () => {
  let resolved = false;
  const spy: HostLookup = async () => {
    resolved = true;
    return [{ address: '142.250.74.101', family: 4 }];
  };
  const result = await guardMailHost('imap.gmail.com', { protocol: 'imap', port: 22, lookup: spy });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'port_not_allowed');
  assert.equal(resolved, false, 'a bad port must not spend a DNS round trip');
});

test('every port transport-autodetect can retry is allowed', () => {
  // The autodetect loop retries a failed connection on the other standard
  // transports. An allowlist narrower than its retry set would reject our own
  // retries, which is a silent regression nobody would attribute to this guard.
  for (const port of [993, 143]) assert.equal(isAllowedMailPort('imap', port), true, `imap ${port}`);
  for (const port of [465, 587, 25]) assert.equal(isAllowedMailPort('smtp', port), true, `smtp ${port}`);
});

test('every port live production inboxes actually use is allowed', () => {
  // Checked against production before the allowlist was written: of 216 live
  // inboxes, every IMAP row is 993 and every SMTP row is 465 or 587.
  assert.equal(isAllowedMailPort('imap', 993), true);
  assert.equal(isAllowedMailPort('smtp', 465), true);
  assert.equal(isAllowedMailPort('smtp', 587), true);
});

/* ── Normalization ──────────────────────────────────────────────────────── */

test('normalization is case-folding, trimming, unbracketing and root-dot stripping', () => {
  assert.equal(normalizeMailHost('  IMAP.Gmail.COM  '), 'imap.gmail.com');
  assert.equal(normalizeMailHost('imap.gmail.com.'), 'imap.gmail.com');
  assert.equal(normalizeMailHost('imap.gmail.com...'), 'imap.gmail.com');
  assert.equal(normalizeMailHost('[::1]'), '::1');
  assert.equal(normalizeMailHost(null), '');
  assert.equal(normalizeMailHost(1234), '');
});
