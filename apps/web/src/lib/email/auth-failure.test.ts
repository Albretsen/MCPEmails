import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuthFailure, explainAuthFailure } from './auth-failure.ts';
import { sanitizeAuthDiagnostic } from './connection-config.ts';
import {
  appPasswordPolicyFor,
  checkAppPasswordShape,
} from '@/lib/email-providers/app-password.ts';

/** The route's own call shape, so the tests exercise what production runs. */
function classify(secret: string, provider: string | null, detail: string | null, usernameProvided = false) {
  const policy = appPasswordPolicyFor(provider);
  return classifyAuthFailure({
    detail,
    policy,
    shape: checkAppPasswordShape(policy, secret),
    usernameProvided,
  });
}

test('a mailbox with IMAP switched off outranks every credential explanation', () => {
  // No password can fix this, so pointing at the password field would send the
  // user round the loop that produced the 24-attempt worst case.
  assert.equal(classify('abcdefghijklmnop', 'zoho', 'NO [ALERT] Please enable IMAP access in your account'), 'imap_disabled');
  assert.equal(classify('Sommer2024!', 'zoho', 'NO IMAP is disabled for this user'), 'imap_disabled');
  // NOT imap_disabled: `[LOGINDISABLED]` is about plaintext auth on this
  // connection, not about a mailbox with IMAP turned off, and telling the user
  // to go and enable a setting that is already on is a wasted attempt.
  assert.equal(classify('Sommer2024!', null, 'NO [LOGINDISABLED] Plaintext authentication disallowed'), 'password_rejected');
});

test('a server that names the credential it wants is believed', () => {
  assert.equal(
    classify('Sommer2024!', null, 'NO [ALERT] Application-specific password required'),
    'app_password_required'
  );
  assert.equal(classify('Sommer2024!', null, 'NO Please use an app password'), 'app_password_required');
});

test('an unrecognised login name is a separate case from a wrong password', () => {
  // Several hosts issue a mail login that is not the address. The fix is a
  // different field, so it must not be reported as a password problem.
  assert.equal(classify('abcdefghijklmnop', null, 'NO Unknown user'), 'login_username_required');
  assert.equal(classify('abcdefghijklmnop', null, 'NO [AUTHENTICATIONFAILED] no such user'), 'login_username_required');
});

test('a login name the user already supplied is not evidence of a missing one', () => {
  // They gave us a login and it was refused; telling them to find a login name
  // is telling them to redo what just failed.
  assert.equal(classify('abcdefghijklmnop', null, 'NO Unknown user', true), 'password_rejected');
});

test('Yahoo’s standard rejection is not read as a login problem', () => {
  // "Incorrect username or password" names both halves precisely because the
  // server will not say which. Reading it as a login problem would send users
  // to change a field that was right.
  const policy = appPasswordPolicyFor('yahoo');
  assert.equal(
    classifyAuthFailure({
      detail: 'NO (#MBR1212) Incorrect username or password.',
      policy,
      shape: checkAppPasswordShape(policy, 'qwertyuiopasdfgh'),
    }),
    'app_password_required'
  );
});

test('a submitted account password is named as one', () => {
  // The strongest signal available, because it is about what the user actually
  // typed rather than about the provider in general.
  assert.equal(classify('Sommer2024!', 'icloud', 'NO [AUTHENTICATIONFAILED] Authentication failed'), 'account_password_used');
  assert.equal(classify('MyYahooPw2024', 'yahoo', 'NO (#MBR1212) Incorrect username or password.'), 'account_password_used');
  // A half-pasted token is also not app-password-shaped, and the sub-case is
  // still "this is not a usable app password".
  assert.equal(classify('qwertyuiop', 'yahoo', 'NO Invalid credentials'), 'account_password_used');
});

test('a well-formed token on an app-password provider still says an app password is required', () => {
  // It looks right and was refused: expired, revoked, or generated for another
  // account. The user's normal password is still not the answer, so the
  // message must not send them to try it.
  assert.equal(classify('abcdefghijklmnop', 'icloud', 'NO [AUTHENTICATIONFAILED] Authentication failed'), 'app_password_required');
});

test('an ordinary mailbox falls back to a plain rejection', () => {
  // A host that authenticates with a real account password gets no app-password
  // advice: it would be wrong, and wrong advice is what produced 3.9 attempts.
  assert.equal(classify('Sommer2024!', null, 'NO [AUTHENTICATIONFAILED] Invalid credentials'), 'password_rejected');
  assert.equal(classify('Sommer2024!', null, null), 'password_rejected');
  assert.equal(classify('Sommer2024!', null, ''), 'password_rejected');
});

test('Zoho gets policy-level guidance without a shape claim', () => {
  // No published format, so nothing is asserted about the string; the provider
  // still refuses account passwords, and that is worth saying.
  assert.equal(classify('Sommer2024!', 'zoho', 'NO Invalid credentials'), 'app_password_required');
});

test('the route-level explanation carries the provider the address identifies', () => {
  // The generic-form case that had no guidance at all: a Yahoo mailbox typed
  // into the IMAP/SMTP form, with no service and no branded card clicked.
  const { reason, fields } = explainAuthFailure({
    detail: 'NO (#MBR1212) Incorrect username or password.',
    email: 'someone@yahoo.com',
    host: 'imap.mail.yahoo.com',
    secret: 'MyYahooPw2024',
  });
  assert.equal(reason, 'account_password_used');
  assert.equal(fields.auth_reason, 'account_password_used');
  assert.equal(fields.auth_provider, 'yahoo');
  assert.match(fields.app_password_url, /^https:\/\//);
});

test('an unidentified host is explained without inventing a provider', () => {
  // No label and no link: naming the wrong company, or sending someone to the
  // wrong settings page, is worse than saying only what we know.
  const { reason, fields } = explainAuthFailure({
    detail: 'NO [AUTHENTICATIONFAILED] Invalid credentials',
    email: 'me@some-random-domain.example',
    host: 'imap.some-random-domain.example',
    secret: 'Sommer2024!',
  });
  assert.equal(reason, 'password_rejected');
  assert.equal(fields.auth_provider, undefined);
  assert.equal(fields.app_password_url, undefined);
});

test('real provider rejections survive sanitisation and still classify', () => {
  // End-to-end from the wire: the raw tagged line goes through the sanitizer
  // that guards it (credential, address and SASL token stripped) and only then
  // reaches the classifier, which is exactly the route's path.
  const icloud = appPasswordPolicyFor('icloud');
  const appleDetail = sanitizeAuthDiagnostic('NO', '[AUTHENTICATIONFAILED] Authentication failed', [
    'someone@icloud.com',
    'Sommer2024!',
  ]);
  assert.equal(
    classifyAuthFailure({
      detail: appleDetail,
      policy: icloud,
      shape: checkAppPasswordShape(icloud, 'Sommer2024!'),
    }),
    'account_password_used'
  );

  // Gmail's wording, which several smaller hosts copy verbatim.
  assert.equal(
    classifyAuthFailure({
      detail: sanitizeAuthDiagnostic('NO', '[ALERT] Application-specific password required.', []),
      policy: null,
    }),
    'app_password_required'
  );

  // Zoho's IMAP-off case, the one that no credential can fix.
  assert.equal(
    classifyAuthFailure({
      detail: sanitizeAuthDiagnostic('NO', 'IMAP access is disabled for this account', []),
      policy: appPasswordPolicyFor('zoho'),
    }),
    'imap_disabled'
  );

  // And the sanitizer must not have left the credential behind for us to leak.
  assert.ok(!appleDetail.includes('Sommer2024!'));
  assert.ok(!appleDetail.includes('someone@icloud.com'));
});
