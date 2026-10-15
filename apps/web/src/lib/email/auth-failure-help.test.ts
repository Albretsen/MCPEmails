import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authFailureHelp, findHostHelp, HOST_HELP, type AuthFailureHelpInput } from './auth-failure-help.ts';
import { PROVIDERS } from '../connect/providers.mjs';

const webRoot = new URL('../../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, webRoot), 'utf8');
const LOCALES = ['en', 'nb', 'es', 'fr', 'zh'];
const messages = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(read(`messages/${locale}/dashboardChrome.json`))])
);
const en = (key: string): string => key.split('.').reduce((node, part) => node?.[part], messages.en);

/** A rejected password on the generic form, the case this module exists for. */
function rejected(over: Partial<AuthFailureHelpInput> = {}) {
  return authFailureHelp({
    reason: 'password_rejected',
    email: 'anna@bakeri-hansen.no',
    host: 'mail.bakeri-hansen.no',
    smtpHost: 'mail.bakeri-hansen.no',
    username: '',
    generic: true,
    ...over,
  });
}
const keys = (help: { lines: { key: string }[] }) => help.lines.map((line) => line.key);

// ── Each host hint ──────────────────────────────────────────────────────────

const HOST_CASES: Array<{ id: string; host: string; label: string; expect: string[] }> = [
  { id: 'ionos', host: 'imap.ionos.com', label: 'IONOS', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereIonos'] },
  { id: 'ionos', host: 'imap.ionos.de', label: 'IONOS', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereIonos'] },
  { id: 'strato', host: 'imap.strato.de', label: 'STRATO', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereStrato'] },
  { id: 'one-com', host: 'imap.one.com', label: 'one.com', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereOneCom'] },
  { id: 'ovh', host: 'ssl0.ovh.net', label: 'OVH', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereOvh'] },
  { id: 'ovh', host: 'ex4.mail.ovh.net', label: 'OVH', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereOvh'] },
  {
    id: 'hostinger',
    host: 'imap.hostinger.com',
    label: 'Hostinger',
    expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereHostinger', 'connect.authHelpTwoFactor'],
  },
  {
    id: 'namecheap',
    host: 'mail.privateemail.com',
    label: 'Namecheap',
    expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereNamecheap', 'connect.authHelpTwoFactorNamecheap'],
  },
  { id: 'siteground', host: 'secure123.sgcpanel.com', label: 'SiteGround', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereSiteground'] },
  { id: 'hostgator', host: 'gator1234.hostgator.com', label: 'HostGator', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereCpanel'] },
  { id: 'hostgator', host: 'srv7.websitewelcome.com', label: 'HostGator', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereCpanel'] },
  { id: 'inmotion', host: 'secure42.inmotionhosting.com', label: 'InMotion Hosting', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereCpanel'] },
  { id: 'inmotion', host: 'secure42.uhserver.com', label: 'InMotion Hosting', expect: ['connect.authHelpMailboxPassword', 'connect.authHelpWhereCpanel'] },
  // Titan's usual cause is its third-party-access switch, so it leads with
  // that and skips the "not your account login" sentence.
  { id: 'titan', host: 'imap.titan.email', label: 'Titan', expect: ['connect.authHelpTitanSwitch', 'connect.authHelpTwoFactor'] },
];

for (const c of HOST_CASES) {
  test(`a rejected password at ${c.host} gets the ${c.id} hint`, () => {
    const help = rejected({ host: c.host, smtpHost: null });
    assert.equal(help.hostId, c.id);
    assert.deepEqual(keys(help), c.expect);
    const first = help.lines[0];
    if (first.key === 'connect.authHelpMailboxPassword') assert.deepEqual(first.values, { host: c.label });
    assert.equal(help.showsUsernameField, false);
  });
}

test('every host in the table is exercised by a case above', () => {
  assert.deepEqual([...new Set(HOST_CASES.map((c) => c.id))].sort(), HOST_HELP.map((entry) => entry.id).sort());
});

test('the SMTP host identifies the mailbox when the IMAP host does not', () => {
  // one.com's two hosts share no label: a login refused on the send half must
  // still be recognised.
  assert.equal(rejected({ host: 'mail.example.com', smtpHost: 'send.one.com' }).hostId, 'one-com');
});

test('an address on the host’s own domain is enough, without a mail host', () => {
  assert.equal(rejected({ email: 'anna@ionos.de', host: '', smtpHost: '' }).hostId, 'ionos');
});

test('host matching ignores case, whitespace and a trailing dot', () => {
  assert.equal(findHostHelp({ host: '  IMAP.Strato.DE. ' })?.id, 'strato');
});

test('a lookalike hostname is not matched', () => {
  assert.equal(findHostHelp({ host: 'imap.strato.de.evil.example' }), null);
  assert.equal(findHostHelp({ host: 'notsgcpanel.com' }), null);
  assert.equal(findHostHelp({ host: 'hostgator.com.example.org' }), null);
});

// ── Facts stay tied to the verified repo content ────────────────────────────

test('every exact mail host in the table is the one the provider registry publishes', () => {
  const published = new Set<string>();
  for (const provider of PROVIDERS as unknown as Array<{ imap?: { host?: string }; smtp?: { host?: string } }>) {
    if (provider.imap?.host) published.add(provider.imap.host);
    if (provider.smtp?.host) published.add(provider.smtp.host);
  }
  for (const entry of HOST_HELP) {
    for (const suffix of entry.hostSuffixes ?? []) {
      if (suffix.startsWith('.')) continue;
      assert.ok(published.has(suffix), `${entry.id}: ${suffix} is not a host in providers.mjs`);
    }
  }
});

test('every source slug has verified content, and suffix hosts appear in it', () => {
  for (const entry of HOST_HELP) {
    assert.ok(entry.sources.length > 0, entry.id);
    const prose = entry.sources.map((slug) => read(`src/lib/connect/content/en/${slug}.json`)).join('\n');
    for (const suffix of entry.hostSuffixes ?? []) {
      if (!suffix.startsWith('.')) continue;
      assert.ok(prose.includes(suffix.slice(1)), `${entry.id}: ${suffix} is not named in its content file`);
    }
  }
});

test('the panel names in the English copy are the ones the content files state', () => {
  // [message key, source slug, phrases that must appear in BOTH].
  const facts: Array<[string, string, string[]]> = [
    ['connect.authHelpWhereIonos', 'ionos', ['IONOS control panel', 'Email']],
    ['connect.authHelpWhereStrato', 'strato', ['Kundenlogin', 'E-Mail-Adressen verwalten']],
    ['connect.authHelpWhereOneCom', 'one-com', ['one.com Control Panel', 'Email tile']],
    ['connect.authHelpWhereOvh', 'ovh', ['OVH control panel', 'email service']],
    ['connect.authHelpWhereHostinger', 'hostinger', ['hPanel', 'Emails']],
    ['connect.authHelpWhereNamecheap', 'namecheap', ['Private Email control panel']],
    ['connect.authHelpTwoFactorNamecheap', 'namecheap', ['Settings', 'Security', 'Application Passwords']],
    ['connect.authHelpWhereSiteground', 'siteground', ['Site Tools', 'Accounts']],
    ['connect.authHelpWhereCpanel', 'hostgator', ['Email Accounts', 'Manage']],
    ['connect.authHelpWhereCpanel', 'inmotion', ['Email Accounts', 'Manage']],
    ['connect.authHelpTitanSwitch', 'titan', ['Settings', 'Enable Titan on Other Apps']],
    ['connect.authHelpOwnDomainWhere', 'hostgator', ['Email Accounts', 'Manage']],
    ['connect.authHelpOwnDomainWhere', 'plesk', ['Mail Accounts']],
  ];
  for (const [key, slug, phrases] of facts) {
    const copy = en(key);
    const content = read(`src/lib/connect/content/en/${slug}.json`);
    for (const phrase of phrases) {
      assert.ok(copy.includes(phrase), `${key} does not say "${phrase}"`);
      assert.ok(content.includes(phrase), `${slug}.json does not say "${phrase}"`);
    }
  }
});

// ── Unknown host ────────────────────────────────────────────────────────────

test('an unknown own-domain host gets the general mailbox-password guidance', () => {
  const help = rejected();
  assert.equal(help.hostId, null);
  assert.deepEqual(keys(help), [
    'connect.authHelpOwnDomainPassword',
    'connect.authHelpOwnDomainWhere',
    'connect.authHelpTwoFactor',
  ]);
  assert.equal(help.showsUsernameField, false);
});

test('a recognised webmail provider is not told about a hosting account', () => {
  const help = rejected({ email: 'anna@gmx.net', host: 'imap.gmx.com' });
  assert.equal(help.hostId, null);
  assert.deepEqual(keys(help), ['connect.authHelpTwoFactor']);
});

// ── The username ────────────────────────────────────────────────────────────

test('a short username on a known host is named as the thing to clear', () => {
  const help = rejected({ host: 'imap.ionos.com', username: 'anna' });
  assert.deepEqual(help.lines.at(-1), { key: 'connect.authHelpUsernameHost', values: { host: 'IONOS' } });
  assert.equal(help.showsUsernameField, true);
});

test('a separate username on an unknown host is questioned, not forbidden', () => {
  const help = rejected({ username: 'anna' });
  assert.equal(keys(help).at(-1), 'connect.authHelpUsernameTyped');
  assert.equal(help.showsUsernameField, true);
});

test('a username that is just the address again is not a separate login', () => {
  const help = rejected({ host: 'imap.ionos.com', username: ' Anna@Bakeri-Hansen.no ' });
  assert.ok(!keys(help).includes('connect.authHelpUsernameHost'));
  assert.equal(help.showsUsernameField, false);
});

// ── Each auth_reason ────────────────────────────────────────────────────────

const base = { email: 'anna@yahoo.com', host: null, generic: false, providerLabel: 'Yahoo Mail' };

for (const [reason, key] of [
  ['imap_disabled', 'connect.imapDisabledDetail'],
  ['app_password_required', 'connect.appPasswordRequiredDetail'],
  ['account_password_used', 'connect.appPasswordAccountDetail'],
  ['app_password_length', 'connect.appPasswordLengthDetail'],
] as const) {
  test(`${reason} keeps its own next step and carries the provider name`, () => {
    for (const generic of [true, false]) {
      const help = authFailureHelp({ ...base, reason, generic });
      assert.deepEqual(help.lines, [{ key, values: { provider: 'Yahoo Mail' } }]);
      assert.equal(help.hostId, null);
    }
  });
}

test('login_username_required points at Advanced settings only where they exist', () => {
  const generic = authFailureHelp({ ...base, reason: 'login_username_required', generic: true });
  assert.deepEqual(keys(generic), ['connect.loginNameDetail']);
  assert.equal(generic.showsUsernameField, true);

  // A branded provider card renders no Advanced section and no Username field.
  const branded = authFailureHelp({ ...base, reason: 'login_username_required', generic: false });
  assert.deepEqual(keys(branded), ['connect.loginNameDetailBranded']);
  assert.equal(branded.showsUsernameField, false);
  for (const locale of LOCALES) {
    const advanced = messages[locale].connect.advancedToggle;
    assert.ok(!messages[locale].connect.loginNameDetailBranded.includes(advanced), locale);
    assert.ok(messages[locale].connect.loginNameDetailBranded.includes(messages[locale].connect.genericLabel), locale);
  }
});

test('password_rejected on a branded card renders nothing host-specific', () => {
  assert.deepEqual(authFailureHelp({ ...base, reason: 'password_rejected', host: 'imap.ionos.com' }).lines, []);
});

test('no reason, or one this build does not know, renders nothing', () => {
  assert.deepEqual(authFailureHelp({ ...base, reason: null }).lines, []);
  assert.deepEqual(authFailureHelp({ ...base, reason: undefined }).lines, []);
  assert.deepEqual(authFailureHelp({ ...base, reason: 'something_new' }).lines, []);
});

// ── The copy itself ─────────────────────────────────────────────────────────

/** Every key the module can return, collected from the source rather than listed twice. */
const ALL_KEYS = [...new Set(read('src/lib/email/auth-failure-help.ts').match(/'connect\.[A-Za-z]+'/g))].map((k) =>
  k.slice(1, -1)
);

test('every key the module can return exists in all five locales', () => {
  assert.ok(ALL_KEYS.length >= 20, `only found ${ALL_KEYS.length} keys`);
  for (const locale of LOCALES) {
    for (const key of ALL_KEYS) {
      const value = key.split('.').reduce((node, part) => node?.[part], messages[locale]);
      assert.equal(typeof value, 'string', `${locale}: ${key} is missing`);
      assert.ok(value.trim().length > 0, `${locale}: ${key} is empty`);
    }
  }
});

test('the new copy is translated, compact, and safe to ship', () => {
  const added = ALL_KEYS.filter((key) => key.includes('authHelp') || key.endsWith('Branded'));
  assert.equal(added.length, 17);
  for (const key of added) {
    const leaf = key.split('.')[1];
    for (const locale of LOCALES) {
      const value: string = messages[locale].connect[leaf];
      // A literal `<` breaks in production; no em or en dashes in user copy.
      assert.ok(!/[<—–]/.test(value), `${locale}: ${key}`);
      assert.ok(value.length <= 320, `${locale}: ${key} is ${value.length} characters`);
      // Only {host} may be interpolated, and only where the module passes it.
      const placeholders = value.match(/\{[^}]*\}/g) ?? [];
      const allowed = ['authHelpMailboxPassword', 'authHelpUsernameHost'].includes(leaf) ? ['{host}'] : [];
      for (const placeholder of placeholders) assert.ok(allowed.includes(placeholder), `${locale}: ${key} ${placeholder}`);
      if (allowed.length > 0) assert.ok(placeholders.length > 0, `${locale}: ${key} lost {host}`);
      if (locale !== 'en') assert.notEqual(value, messages.en.connect[leaf], `${locale}: ${key} is untranslated`);
      // Never a reference to UI the generic form may not be showing.
      assert.ok(!value.includes(messages[locale].connect.advancedToggle), `${locale}: ${key}`);
    }
  }
});

test('the help takes no secret, so it cannot echo one', () => {
  const help = authFailureHelp({
    reason: 'password_rejected',
    email: 'anna@bakeri-hansen.no',
    host: 'imap.ionos.com',
    username: 'anna',
    generic: true,
    // Not part of the input type: proves a stray field is ignored.
    ...({ password: 'Sommer2024!', detail: 'NO AUTHENTICATE failed dXNlcg==' } as object),
  });
  const rendered = JSON.stringify(help);
  assert.ok(!rendered.includes('Sommer2024!'));
  assert.ok(!rendered.includes('dXNlcg=='));
  assert.ok(!rendered.includes('anna'));
});
