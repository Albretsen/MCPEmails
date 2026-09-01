import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_HOST_PRESETS,
  emailDomain,
  findMailHostPreset,
  prefillFromEmail,
} from './host-presets.ts';

test('every host in the recorded failure data is recognised', () => {
  // These are the exact hostnames that produced repeated connection failures in
  // production. Each one has to resolve to settings, or the table is decorative.
  const cases: [string, string][] = [
    ['imap.ionos.com', 'ionos'],
    ['imap.hostinger.com', 'hostinger'],
    ['ex4.mail.ovh.net', 'ovh-exchange'],
    ['ssl0.ovh.net', 'ovh'],
    ['imap.dreamhost.com', 'dreamhost'],
    ['mail.b.hostedemail.com', 'hostedemail'],
    ['imap.titan.email', 'titan'],
    ['mail.privateemail.com', 'privateemail'],
    ['imap.migadu.com', 'migadu'],
    ['secure28.uhserver.com', 'uhserver'],
  ];
  for (const [host, id] of cases) {
    assert.equal(findMailHostPreset({ host })?.id, id, host);
  }
});

test('OVH Hosted Exchange wins over OVH shared hosting, and gets 587', () => {
  // The specific suffix has to be matched first: Hosted Exchange does not
  // listen on 465 at all, so falling through to the shared-hosting entry would
  // produce exactly the connection that hangs until it times out.
  const exchange = findMailHostPreset({ host: 'ex4.mail.ovh.net' });
  assert.equal(exchange?.id, 'ovh-exchange');
  assert.equal(exchange?.smtpPort, 587);
  assert.equal(exchange?.smtpSecurity, 'starttls');

  assert.equal(findMailHostPreset({ host: 'ssl0.ovh.net' })?.smtpPort, 465);
});

test('an address on the provider’s own domain resolves without a host', () => {
  assert.equal(findMailHostPreset({ email: 'user@gmx.net' })?.id, 'gmx');
  assert.equal(findMailHostPreset({ email: 'user@mail.com' })?.id, 'mailcom');
  assert.equal(findMailHostPreset({ email: 'user@zohomail.com' })?.id, 'zoho');
  assert.equal(findMailHostPreset({ email: 'USER@Yahoo.COM' })?.id, 'yahoo');
  assert.equal(findMailHostPreset({ email: 'user@me.com' })?.id, 'icloud');
});

test('the mail host beats the email domain when the two disagree', () => {
  // A custom domain says nothing about where its mail lives; the hostname is
  // the mail server itself, so it is the stronger signal.
  const preset = findMailHostPreset({ email: 'user@some-agency.co', host: 'imap.titan.email' });
  assert.equal(preset?.id, 'titan');
});

test('an unknown mailbox resolves to nothing rather than to a guess', () => {
  // Inventing a host from a domain name would point a user's credentials at a
  // server that is not theirs, so no match must stay no match.
  assert.equal(findMailHostPreset({ email: 'user@some-random-domain.example' }), null);
  assert.equal(findMailHostPreset({ host: 'p250k.chinaemail.cn' }), null);
  assert.equal(findMailHostPreset({}), null);
  assert.equal(findMailHostPreset({ email: '', host: '' }), null);
  assert.equal(findMailHostPreset({ email: 'not-an-address' }), null);
});

test('addresses are parsed the way people type them', () => {
  assert.equal(emailDomain('  User@Example.COM  '), 'example.com');
  // A trailing dot is a valid FQDN and must not become a separate domain.
  assert.equal(emailDomain('user@example.com.'), 'example.com');
  // A plus-addressed local part containing an @ is not a second domain.
  assert.equal(emailDomain('a@b@example.com'), 'example.com');
  assert.equal(emailDomain('nope'), '');
});

test('a prefill carries a complete, self-consistent transport', () => {
  const prefill = prefillFromEmail('someone@gmx.net');
  assert.equal(prefill?.imapHost, 'imap.gmx.com');
  assert.equal(prefill?.imapPort, 993);
  assert.equal(prefill?.imapSecurity, 'tls');
  // GMX documents submission on 587/STARTTLS, not 465.
  assert.equal(prefill?.smtpPort, 587);
  assert.equal(prefill?.smtpSecurity, 'starttls');
  assert.equal(prefillFromEmail('someone@unknown.example'), null);
});

test('app-password providers are flagged with somewhere to go', () => {
  // The point of the flag is to replace a guess about credentials with a fact,
  // so it is worthless without the link that acts on it.
  for (const preset of MAIL_HOST_PRESETS) {
    if (preset.requiresAppPassword) {
      assert.ok(preset.appPasswordHelpUrl, `${preset.id} claims an app password with no link`);
      assert.ok(preset.appPasswordHelpUrl?.startsWith('https://'), preset.id);
    }
  }
  assert.equal(prefillFromEmail('someone@yahoo.com')?.requiresAppPassword, true);
  assert.equal(prefillFromEmail('someone@gmx.net')?.requiresAppPassword, false);
  // Gmail: the generic form has to say the same thing the Gmail card says,
  // because a Google account password cannot authenticate a mail client no
  // matter which door the user came through.
  assert.equal(prefillFromEmail('someone@gmail.com')?.requiresAppPassword, true);
});

test('every entry is internally consistent', () => {
  const ids = new Set<string>();
  for (const preset of MAIL_HOST_PRESETS) {
    assert.ok(!ids.has(preset.id), `duplicate id ${preset.id}`);
    ids.add(preset.id);
    assert.ok(preset.domains?.length || preset.hostSuffixes?.length, `${preset.id} is unreachable`);
    for (const port of [preset.imapPort, preset.smtpPort]) {
      assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `${preset.id} port ${port}`);
    }
    // An implicit-TLS entry on a STARTTLS port (or the reverse) is the exact
    // mismatch this table exists to remove, so it must not be in the table.
    assert.equal(preset.imapSecurity, preset.imapPort === 143 ? 'starttls' : 'tls', preset.id);
    if (preset.smtpPort === 465) assert.equal(preset.smtpSecurity, 'tls', preset.id);
    if (preset.smtpPort === 587 || preset.smtpPort === 25) assert.equal(preset.smtpSecurity, 'starttls', preset.id);
  }
});

test('a Google mailbox is recognised from the address or from the host', () => {
  assert.equal(findMailHostPreset({ email: 'me@gmail.com' })?.id, 'gmail');
  assert.equal(findMailHostPreset({ email: 'me@googlemail.com' })?.id, 'gmail');
  // A Google Workspace custom domain says nothing in its address; the mail
  // host is the only thing that identifies it, and that is the half of the
  // lookup that exists for exactly this case.
  assert.equal(findMailHostPreset({ email: 'me@example.com', host: 'imap.gmail.com' })?.id, 'gmail');

  const prefill = prefillFromEmail('me@gmail.com');
  assert.equal(prefill?.imapHost, 'imap.gmail.com');
  assert.equal(prefill?.imapPort, 993);
  assert.equal(prefill?.smtpHost, 'smtp.gmail.com');
  assert.equal(prefill?.smtpPort, 465);
});
