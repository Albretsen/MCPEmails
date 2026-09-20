import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSUMER_BRAND_FAMILIES,
  CONSUMER_EMAIL_DOMAINS,
  emailDomain,
  isBusinessEmailDomain,
  isBusinessShaped,
  isBusinessShapedWorkspace,
  isConsumerEmailDomain,
} from './consumer-domains.mjs';

// Only reserved example domains below. Never a real customer's.

test('the big consumer webmail services are not businesses', () => {
  for (const address of [
    'ada@gmail.com',
    'ada@googlemail.com',
    'ada@yahoo.com',
    'ada@icloud.com',
    'ada@me.com',
    'ada@outlook.com',
    'ada@hotmail.com',
    'ada@live.com',
    'ada@aol.com',
    'ada@proton.me',
    'ada@protonmail.com',
    'ada@gmx.de',
    'ada@yandex.ru',
    'ada@mail.ru',
    'ada@qq.com',
    'ada@fastmail.com',
  ]) {
    assert.equal(isBusinessEmailDomain(address), false, `${address} must be consumer`);
    assert.equal(isConsumerEmailDomain(address), true, `${address} must be consumer`);
  }
});

test('the regional variants the 2026-09-20 measurement got wrong are consumer', () => {
  // The seed list named ten Yahoo domains and missed the eleventh. A brand
  // family has no eleventh to miss.
  for (const address of [
    'ada@yahoo.in',
    'ada@yahoo.co.jp',
    'ada@yahoo.com.mx',
    'ada@hotmail.no',
    'ada@hotmail.se',
    'ada@outlook.com.ar',
    'ada@outlook.dk',
    'ada@live.se',
    'ada@live.com.au',
    'ada@gmx.at',
    'ada@yandex.kz',
    'ada@yandex.com.tr',
    'ada@aol.co.uk',
    'ada@protonmail.ch',
  ]) {
    assert.equal(isBusinessEmailDomain(address), false, `${address} must be consumer`);
  }
});

test('ISPs are consumer, including the Canadian ones that were missing', () => {
  for (const address of [
    'ada@rogers.com',
    'ada@shaw.ca',
    'ada@bell.net',
    'ada@sympatico.ca',
    'ada@telus.net',
    'ada@comcast.net',
    'ada@t-online.de',
    'ada@btinternet.com',
    'ada@orange.fr',
    'ada@online.no',
    'ada@bigpond.com',
  ]) {
    assert.equal(isBusinessEmailDomain(address), false, `${address} must be consumer`);
  }
});

test('a company on its own domain is a business', () => {
  for (const address of [
    'info@acme.example',
    'sales@acme.example',
    'facturas@acme.example',
    'ada@studio.example.com',
    'ada@acme.co.uk',
    'ada@acme.com.br',
    'ada@acme.no',
  ]) {
    assert.equal(isBusinessEmailDomain(address), true, `${address} must be business`);
    assert.equal(isConsumerEmailDomain(address), false);
  }
});

test('a brand word inside a longer name, or as a subdomain, is not that brand', () => {
  // The family rule matches a LABEL, never a substring, and only in the
  // registrable position.
  for (const address of [
    'ada@livestock.example',
    'ada@outlookfarm.example',
    'ada@yahoomarketing.example',
    'ada@protonics.example',
    'ada@gmxtra.example',
    'ada@yahoo.acme.example',
    'ada@live.acme.example',
    'ada@mail.outlook.acme.example',
  ]) {
    assert.equal(isBusinessEmailDomain(address), true, `${address} must be business`);
  }
});

test('a subdomain of a consumer service is still that service', () => {
  assert.equal(isBusinessEmailDomain('ada@mail.yahoo.com'), false);
  assert.equal(isBusinessEmailDomain('ada@nyc.rr.com'), false);
});

test('case and surrounding whitespace do not change the answer', () => {
  assert.equal(isBusinessEmailDomain('  Ada@GMAIL.com '), false);
  assert.equal(isBusinessEmailDomain('ADA@YAHOO.IN'), false);
  assert.equal(isBusinessEmailDomain('\tINFO@Acme.Example\n'), true);
  assert.equal(emailDomain('  INFO@Acme.Example.  '), 'acme.example');
});

test('a bare domain is classified the same as an address on it', () => {
  assert.equal(isBusinessEmailDomain('gmail.com'), false);
  assert.equal(isBusinessEmailDomain('hotmail.no'), false);
  assert.equal(isBusinessEmailDomain('acme.example'), true);
});

test('garbage is NOT business: an unknown workspace keeps today\'s paywall', () => {
  for (const garbage of [
    undefined,
    null,
    '',
    '   ',
    0,
    42,
    true,
    {},
    [],
    ['info@acme.example'],
    () => 'info@acme.example',
    'not an email',
    'ada',
    'ada@',
    '@acme.example',
    'ada@localhost',
    'ada@acme',
    'ada@127.0.0.1',
    'ada@-acme.example',
    'ada@acme..example',
    'ada@acme example.com',
    `ada@${'a'.repeat(300)}.example`,
  ]) {
    assert.equal(isBusinessEmailDomain(garbage), false, `${String(garbage)} must not be business`);
    // Garbage is not "consumer" either. It is no signal at all.
    assert.equal(isConsumerEmailDomain(garbage), false);
  }
});

test('garbage never throws', () => {
  assert.doesNotThrow(() => isBusinessEmailDomain(Symbol('x')));
  assert.doesNotThrow(() => isBusinessShaped(Symbol('x')));
  assert.doesNotThrow(() => isBusinessShapedWorkspace(Symbol('x')));
  assert.doesNotThrow(() => isBusinessShapedWorkspace({ inboxes: [null, undefined, 7, {}] }));
});

test('the last "@" is the boundary', () => {
  assert.equal(emailDomain('"odd@local"@acme.example'), 'acme.example');
  assert.equal(isBusinessEmailDomain('"odd@gmail.com"@acme.example'), true);
  assert.equal(isBusinessEmailDomain('"odd@acme.example"@gmail.com'), false);
});

test('schools are not businesses, by the two trivial rules only', () => {
  assert.equal(isBusinessEmailDomain('ada@university.edu'), false);
  assert.equal(isBusinessEmailDomain('ada@cs.university.edu'), false);
  assert.equal(isBusinessEmailDomain('ada@college.ac.uk'), false);
  assert.equal(isBusinessEmailDomain('ada@college.edu.au'), false);
  // Not a school: "edu" and "ac" only count in the academic positions.
  assert.equal(isBusinessEmailDomain('ada@edu.example'), true);
  assert.equal(isBusinessEmailDomain('ada@ac.example'), true);
  assert.equal(isBusinessEmailDomain('ada@education.example'), true);
});

test('one business mailbox makes a mixed workspace business-shaped', () => {
  // The common real shape: a personal Gmail signed up, the company's info@ is
  // the mailbox that got connected.
  assert.equal(isBusinessShaped(['ada@gmail.com', 'info@acme.example']), true);
  assert.equal(isBusinessShaped(['info@acme.example', 'ada@gmail.com']), true);
});

test('an all-consumer workspace is not business-shaped', () => {
  assert.equal(isBusinessShaped(['ada@gmail.com']), false);
  assert.equal(isBusinessShaped(['ada@gmail.com', 'ada@yahoo.in', 'ada@rogers.com']), false);
});

test('no addresses, or no usable ones, is not business-shaped', () => {
  assert.equal(isBusinessShaped([]), false);
  assert.equal(isBusinessShaped(undefined), false);
  assert.equal(isBusinessShaped(null), false);
  assert.equal(isBusinessShaped('info@acme.example'), false);
  assert.equal(isBusinessShaped([undefined, null, '', 7, {}]), false);
  // Garbage beside a real business address does not mask it.
  assert.equal(isBusinessShaped([undefined, 'info@acme.example']), true);
});

test('the workspace signal reads connected inboxes, and ORs in the owner email', () => {
  const gmailInbox = { id: 'ib-1', address: 'ada@gmail.com' };
  const companyInbox = { id: 'ib-2', address: 'info@acme.example' };

  assert.equal(isBusinessShapedWorkspace({ inboxes: [companyInbox] }), true);
  assert.equal(isBusinessShapedWorkspace({ inboxes: [gmailInbox] }), false);
  assert.equal(isBusinessShapedWorkspace({ inboxes: [gmailInbox, companyInbox] }), true);

  // The owner signed up with the company address but connected a Gmail first.
  assert.equal(
    isBusinessShapedWorkspace({ inboxes: [gmailInbox], ownerEmail: 'ada@acme.example' }),
    true,
  );
  // A consumer owner adds nothing, and takes nothing away.
  assert.equal(
    isBusinessShapedWorkspace({ inboxes: [gmailInbox], ownerEmail: 'ada@hotmail.no' }),
    false,
  );
  assert.equal(
    isBusinessShapedWorkspace({ inboxes: [companyInbox], ownerEmail: 'ada@gmail.com' }),
    true,
  );

  // Nothing known is not business.
  assert.equal(isBusinessShapedWorkspace(), false);
  assert.equal(isBusinessShapedWorkspace({}), false);
  assert.equal(isBusinessShapedWorkspace({ inboxes: null, ownerEmail: null }), false);
  assert.equal(isBusinessShapedWorkspace({ inboxes: 'info@acme.example' }), false);
});

test('the domain list is clean: lower-case, unique, valid, and self-consistent', () => {
  const seen = new Set();
  for (const domain of CONSUMER_EMAIL_DOMAINS) {
    assert.equal(domain, domain.toLowerCase().trim(), `${domain} must be normalised`);
    assert.equal(seen.has(domain), false, `${domain} is listed twice`);
    seen.add(domain);
    // Every listed domain must survive the module's own parser, or it is a
    // dead entry that can never match.
    assert.equal(emailDomain(domain), domain, `${domain} does not parse as a domain`);
    assert.equal(isBusinessEmailDomain(`someone@${domain}`), false);
  }
  for (const brand of CONSUMER_BRAND_FAMILIES) {
    assert.match(brand, /^[a-z0-9]+$/);
    assert.equal(isBusinessEmailDomain(`someone@${brand}.xx`), false);
  }
});

test('the seed list from the segment measurement is fully carried over', () => {
  // A sample across every row of the SQL array in
  // docs/PLAN-multi-mailbox-business-segment.md section 3.4, so a careless
  // edit that drops a region is noticed.
  for (const domain of [
    'gmail.com', 'rocketmail.com', 'mac.com', 'outlook.com.br', 'hotmail.de',
    'msn.com', 'pm.me', 'list.ru', 'freenet.de', 'migadu.com', 'rediffmail.com',
    'bellsouth.net', 'frontier.com', 'laposte.net', 'tiscali.it', 'globo.com',
    'planet.nl', 'abv.bg', 'usa.com', 'mailinator.com',
  ]) {
    assert.ok(CONSUMER_EMAIL_DOMAINS.includes(domain), `${domain} missing from the list`);
  }
});
