import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_HOST_PRESETS,
  emailDomain,
  findMailHostPreset,
  findMailHostPresetByMx,
  isYahooJapanAddress,
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
    ['imap.uhserver.com', 'uhserver'],
    ['email-ssl.com.br', 'locaweb'],
    ['imap.strato.de', 'strato'],
    ['mail.your-server.de', 'hetzner'],
    ['exchange.ionos.eu', 'ionos-exchange'],
    ['imap.world4you.com', 'world4you'],
    ['imap.mail.hostpoint.ch', 'hostpoint'],
    ['mail.cyon.ch', 'cyon'],
    ['imaps.bluewin.ch', 'bluewin'],
  ];
  for (const [host, id] of cases) {
    assert.equal(findMailHostPreset({ host })?.id, id, host);
  }
});

test('a typed IONOS host keeps its region: European names never become imap.ionos.com', () => {
  const cases: [string, string, string][] = [
    ['imap.ionos.de', 'ionos-de', 'imap.ionos.de'],
    ['imap.1und1.de', 'ionos-de', 'imap.ionos.de'],
    ['smtp.ionos.co.uk', 'ionos-uk', 'imap.ionos.co.uk'],
    ['imap.ionos.fr', 'ionos-fr', 'imap.ionos.fr'],
    ['imap.ionos.es', 'ionos-es', 'imap.ionos.es'],
    ['imap.ionos.it', 'ionos-it', 'imap.ionos.it'],
    ['imap.ionos.com', 'ionos', 'imap.ionos.com'],
  ];
  for (const [host, id, imapHost] of cases) {
    const preset = findMailHostPreset({ host });
    assert.equal(preset?.id, id, host);
    assert.equal(preset?.imapHost, imapHost, host);
  }
  assert.equal(findMailHostPreset({ email: 'anna@ionos.de' })?.imapHost, 'imap.ionos.de');
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
  assert.equal(prefill?.imapHost, 'imap.gmx.net');
  assert.equal(prefill?.imapPort, 993);
  assert.equal(prefill?.imapSecurity, 'tls');
  assert.equal(prefill?.smtpHost, 'mail.gmx.net');
  assert.equal(prefill?.smtpPort, 465);
  assert.equal(prefill?.smtpSecurity, 'tls');
  assert.equal(prefillFromEmail('someone@unknown.example'), null);
});

test('GMX: the German platform gets the hosts the German GMX help documents, gmx.com keeps its own', () => {
  // The registry and /connect/gmx say imap.gmx.net and mail.gmx.net:465, so
  // every German-platform address must get the same answer.
  for (const domain of ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch']) {
    const prefill = prefillFromEmail(`a@${domain}`);
    assert.equal(prefill?.imapHost, 'imap.gmx.net', domain);
    assert.equal(prefill?.smtpHost, 'mail.gmx.net', domain);
    assert.equal(prefill?.smtpPort, 465, domain);
  }
  const com = prefillFromEmail('a@gmx.com');
  assert.equal(com?.imapHost, 'imap.gmx.com');
  assert.deepEqual([com?.smtpHost, com?.smtpPort, com?.smtpSecurity], ['mail.gmx.com', 587, 'starttls']);
  // A typed .com host is still GMX for a German address.
  assert.equal(findMailHostPreset({ email: 'a@gmx.de', host: 'imap.gmx.com' })?.label, 'GMX');
});

test('UOL Host is labelled as UOL Host, on the hosts that actually listen', () => {
  // It used to be labelled InMotion and point at mail.uhserver.com, which
  // does not listen on 993.
  const preset = findMailHostPreset({ email: 'contato@empresa.example', host: 'imap.uhserver.com' });
  assert.equal(preset?.label, 'UOL Host');
  assert.equal(preset?.imapHost, 'imap.uhserver.com');
  assert.deepEqual([preset?.smtpHost, preset?.smtpPort, preset?.smtpSecurity], ['smtps.uhserver.com', 465, 'tls']);
  assert.equal(findMailHostPreset({ host: 'smtps.uhserver.com' })?.id, 'uhserver');
});

test('Yahoo country domains are Yahoo; Yahoo! JAPAN is its own provider with no app password', () => {
  for (const domain of ['yahoo.com.br', 'yahoo.com.ar', 'yahoo.com.mx', 'yahoo.es', 'yahoo.it', 'yahoo.ca']) {
    const preset = findMailHostPreset({ email: `a@${domain}` });
    assert.equal(preset?.id, 'yahoo', domain);
    assert.equal(preset?.requiresAppPassword, true, domain);
  }
  for (const email of ['a@yahoo.co.jp', 'a@ymail.ne.jp']) {
    const preset = findMailHostPreset({ email });
    assert.equal(preset?.id, 'yahoo-jp', email);
    assert.equal(preset?.imapHost, 'imap.mail.yahoo.co.jp');
    assert.equal(preset?.requiresAppPassword, undefined, 'Yahoo! JAPAN has no app passwords');
  }
  // The JP MX names sit under the host suffix, and never under Yahoo's.
  assert.equal(findMailHostPresetByMx('mx1.mail.yahoo.co.jp')?.id, 'yahoo-jp');
  assert.equal(findMailHostPreset({ host: 'imap.mail.yahoo.co.jp' })?.id, 'yahoo-jp');

  assert.equal(isYahooJapanAddress(' A@Yahoo.CO.JP '), true);
  assert.equal(isYahooJapanAddress('a@ymail.ne.jp'), true);
  for (const email of ['a@yahoo.com', 'a@yahoo.com.br', 'a@ymail.com', 'a@yahoo.co.jp.example', '', 'yahoo.co.jp']) {
    assert.equal(isYahooJapanAddress(email), false, email);
  }
});

test('Japanese ISP mail resolves from the address, with the documented ports', () => {
  const cases: [string, string, string, number, string][] = [
    ['a@docomo.ne.jp', 'docomo', 'imap.spmode.ne.jp', 465, 'smtp.spmode.ne.jp'],
    ['a@i.softbank.jp', 'softbank', 'imap.softbank.jp', 465, 'smtp.softbank.jp'],
    ['a@ocn.ne.jp', 'ocn', 'imap.ocn.ne.jp', 465, 'smtp.ocn.ne.jp'],
    ['a@biglobe.ne.jp', 'biglobe', 'mail.biglobe.ne.jp', 465, 'mail.biglobe.ne.jp'],
    ['a@nifty.com', 'nifty', 'imap.nifty.com', 465, 'smtp.nifty.com'],
    ['a@so-net.ne.jp', 'so-net', 'imap.so-net.ne.jp', 587, 'mail.so-net.ne.jp'],
    ['a@plala.or.jp', 'plala', 'imap.plala.or.jp', 465, 'secure.plala.or.jp'],
  ];
  for (const [email, id, imapHost, smtpPort, smtpHost] of cases) {
    const preset = findMailHostPreset({ email });
    assert.equal(preset?.id, id, email);
    assert.equal(preset?.imapHost, imapHost, email);
    assert.equal(preset?.smtpHost, smtpHost, email);
    assert.equal(preset?.smtpPort, smtpPort, email);
  }
  assert.equal(findMailHostPreset({ host: 'imap2.spmode.ne.jp' })?.id, 'docomo');
});

test('Brazilian and DACH consumer domains resolve from the address', () => {
  const cases: [string, string, number][] = [
    ['a@uol.com.br', 'uol', 587],
    ['a@bol.com.br', 'bol', 465],
    ['a@terra.com.br', 'terra', 465],
    ['a@freenet.de', 'freenet', 465],
    ['a@arcor.de', 'vodafone', 465],
    ['a@vodafone.de', 'vodafone', 465],
    ['a@aon.at', 'a1', 587],
    ['a@bluewin.ch', 'bluewin', 465],
    ['a@strato.de', 'strato', 465],
  ];
  for (const [email, id, smtpPort] of cases) {
    const preset = findMailHostPreset({ email });
    assert.equal(preset?.id, id, email);
    assert.equal(preset?.smtpPort, smtpPort, email);
  }
  // World4You refuses 465; its preset must say 587.
  assert.deepEqual(
    [findMailHostPreset({ host: 'smtp.world4you.com' })?.smtpPort, findMailHostPreset({ host: 'smtp.world4you.com' })?.smtpSecurity],
    [587, 'starttls'],
  );
});

test('custom domains are recognised from the MX the host publishes', () => {
  const cases: [string, string, string][] = [
    ['mx.core.locaweb.com.br', 'locaweb', 'email-ssl.com.br'],
    ['mx.jk.locaweb.com.br', 'locaweb', 'email-ssl.com.br'],
    ['smtpin.rzone.de', 'strato', 'imap.strato.de'],
    ['www123.your-server.de', 'hetzner', 'mail.your-server.de'],
    ['mx.mail.hostpoint.ch', 'hostpoint', 'imap.mail.hostpoint.ch'],
    ['mx01.cyon.ch', 'cyon', 'mail.cyon.ch'],
    ['mx01.p.bluenet.ch', 'bluewin', 'imaps.bluewin.ch'],
    ['mx.vodafonemail.de', 'vodafone', 'imap.vodafonemail.de'],
  ];
  for (const [mx, id, imapHost] of cases) {
    const preset = findMailHostPresetByMx(mx);
    assert.equal(preset?.id, id, mx);
    assert.equal(preset?.imapHost, imapHost, mx);
  }
  // Locaweb also runs other brands' mail under locaweb.com.br; those users do
  // not sign in at email-ssl.com.br, so only the exact Locaweb MX names count.
  assert.equal(findMailHostPresetByMx('mx1.r7.email.locaweb.com.br'), null);
  assert.equal(findMailHostPresetByMx('mx.core.locaweb.com.br.evil.example'), null);
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

// ─── Personal Microsoft addresses (microsoft-accounts.ts) ─────────────────────

import {
  isMicrosoftConsumerAddress,
  isMicrosoftConsumerDomain,
  microsoftAccountErrorBody,
  MICROSOFT_ACCOUNT_USE_OUTLOOK,
} from './microsoft-accounts.ts';

test('personal Microsoft addresses are recognised, including country variants', () => {
  for (const email of [
    'a@outlook.com', 'a@hotmail.com', 'a@live.com', 'a@msn.com',
    'a@hotmail.no', 'a@outlook.de', 'a@live.co.uk', 'a@hotmail.co.uk',
    'a@outlook.com.br', 'a@live.no', 'a@live.nl', 'A@Outlook.COM', ' a@hotmail.fr ',
  ]) {
    assert.equal(isMicrosoftConsumerAddress(email), true, email);
  }
});

test('custom domains, lookalikes and Microsoft 365 business domains are never matched', () => {
  for (const email of [
    'a@example.com', 'a@mcpemails.com', 'a@contoso.onmicrosoft.com', 'a@microsoft.com',
    'a@outlook.example.org', 'a@myoutlook.com', 'a@live.io', 'a@outlook.io', 'a@live.dev',
    'a@hotmail.co', 'a@msn.org', 'outlook.com', '',
  ]) {
    assert.equal(isMicrosoftConsumerAddress(email), false, email);
  }
  assert.equal(isMicrosoftConsumerDomain('outlook.com'), true);
});

test('the refusal carries the code the connect modal maps to its headline', () => {
  const body = microsoftAccountErrorBody();
  assert.equal(body.error_code, MICROSOFT_ACCOUNT_USE_OUTLOOK);
  assert.equal(body.error_code, 'microsoft_account_use_outlook');
  assert.match(body.error, /Outlook/);
});
