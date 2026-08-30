import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appPasswordPolicyFor,
  checkAppPasswordShape,
  identifyAppPasswordProvider,
} from './app-password.ts';

test('an address alone identifies the provider, which is the generic-form gap', () => {
  // The whole point: someone typing this into the generic IMAP form never
  // clicked a logo, so without the address there is nothing to key guidance on.
  const cases: [string, string][] = [
    ['someone@icloud.com', 'icloud'],
    ['someone@me.com', 'icloud'],
    ['someone@yahoo.co.uk', 'yahoo'],
    ['someone@ymail.com', 'yahoo'],
    ['someone@yandex.ru', 'yandex'],
    ['someone@fastmail.com', 'fastmail'],
    ['someone@zohomail.com', 'zoho'],
  ];
  for (const [email, provider] of cases) {
    assert.equal(identifyAppPasswordProvider({ email })?.provider, provider, email);
  }
});

test('a custom domain is identified from the mail host instead', () => {
  // Most affected users are on their own domain, so the address says nothing
  // and the host they were given by their provider is the only signal.
  const policy = identifyAppPasswordProvider({ email: 'me@my-agency.co', host: 'imap.mail.me.com' });
  assert.equal(policy?.provider, 'icloud');
  assert.equal(policy?.requiresAppPassword, true);
});

test('the branded card the user clicked outranks the address', () => {
  // A Fastmail account on a custom domain hosted elsewhere must still get
  // Fastmail's guidance: the user told us which provider they picked.
  const policy = identifyAppPasswordProvider({ service: 'fastmail', email: 'me@my-agency.co' });
  assert.equal(policy?.provider, 'fastmail');
});

test('an unknown mailbox yields no policy rather than a guess', () => {
  assert.equal(identifyAppPasswordProvider({ email: 'me@some-random-domain.example' }), null);
  assert.equal(identifyAppPasswordProvider({ service: 'generic', email: '' }), null);
  // A recognised host that authenticates with an ordinary password must not be
  // told it needs an app password.
  assert.equal(identifyAppPasswordProvider({ host: 'imap.ionos.com' }), null);
});

test('every app-password policy carries the generator link it promises', () => {
  for (const provider of ['icloud', 'yahoo', 'yandex', 'zoho', 'fastmail']) {
    const policy = appPasswordPolicyFor(provider);
    assert.ok(policy, provider);
    assert.match(policy.helpUrl, /^https:\/\//, provider);
    assert.ok(policy.label.length > 0, provider);
  }
});

test('a genuine app password passes, in the shape each provider displays it', () => {
  const icloud = appPasswordPolicyFor('icloud');
  // Apple shows four hyphenated groups; both the displayed and the pasted-plain
  // form are the same credential.
  assert.deepEqual(checkAppPasswordShape(icloud, 'abcd-efgh-ijkl-mnop'), { ok: true });
  assert.deepEqual(checkAppPasswordShape(icloud, 'abcdefghijklmnop'), { ok: true });
  // A copy-paste that dragged in a newline and a non-breaking space is still
  // the same credential, and must not be rejected before it is even tried.
  assert.deepEqual(checkAppPasswordShape(icloud, ' abcd efgh ijkl mnop\n'), { ok: true });

  assert.deepEqual(checkAppPasswordShape(appPasswordPolicyFor('yahoo'), 'qwertyuiopasdfgh'), { ok: true });
  assert.deepEqual(checkAppPasswordShape(appPasswordPolicyFor('yandex'), 'qwertyuiopasdfgh'), { ok: true });
  // Fastmail's alphabet includes digits.
  assert.deepEqual(checkAppPasswordShape(appPasswordPolicyFor('fastmail'), 'a1b2c3d4e5f6g7h8'), { ok: true });
});

test('a plausible account password is rejected as one', () => {
  // This is the mistake behind most recorded auth failures: the password the
  // person logs into webmail with, submitted where a generated token belongs.
  const icloud = appPasswordPolicyFor('icloud');
  for (const secret of ['Sommer2024!', 'correcthorsebatterystaple1', 'Passord123', 'MyApplePw!']) {
    assert.deepEqual(checkAppPasswordShape(icloud, secret), { ok: false, problem: 'account_password' }, secret);
  }
  // Digits are outside Yahoo's and Yandex's alphabet too, even at 16 characters.
  assert.deepEqual(
    checkAppPasswordShape(appPasswordPolicyFor('yahoo'), 'abcd1234efgh5678'),
    { ok: false, problem: 'account_password' }
  );
});

test('a truncated paste is reported as a length problem, not an account password', () => {
  // Different fix: nothing is wrong with what they fetched, only with how much
  // of it arrived, so telling them to go and generate another one is wrong.
  assert.deepEqual(
    checkAppPasswordShape(appPasswordPolicyFor('yahoo'), 'qwertyuiop'),
    { ok: false, problem: 'wrong_length' }
  );
  assert.deepEqual(
    checkAppPasswordShape(appPasswordPolicyFor('icloud'), 'abcd-efgh-ijkl-mnop-qrst'),
    { ok: false, problem: 'wrong_length' }
  );
});

test('no opinion is offered where the provider fixes no format', () => {
  // Zoho generates device passwords with no published shape. Inventing a rule
  // there would reject credentials that work, which is worse than the failure
  // this module exists to prevent.
  assert.deepEqual(checkAppPasswordShape(appPasswordPolicyFor('zoho'), 'Sommer2024!'), { ok: true, unknown: true });
  assert.deepEqual(checkAppPasswordShape(null, 'anything'), { ok: true, unknown: true });
  // An empty box is the form's own error, not a shape verdict.
  assert.deepEqual(checkAppPasswordShape(appPasswordPolicyFor('yahoo'), ''), { ok: true, unknown: true });
});
