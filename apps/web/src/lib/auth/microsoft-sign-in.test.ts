// ---------------------------------------------------------------------------
// Sign in with Microsoft: which sessions the callback guard refuses, how
// failed OAuth redirects map to /auth/error reasons, and why a Microsoft
// sign-in for an existing email never creates a second workspace.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/auth/microsoft-sign-in.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MICROSOFT_CONSUMER_TENANT_ID,
  isMicrosoftEmailVerified,
  microsoftSignInRefusal,
  oauthErrorReason,
  signedInIdentity,
} from './microsoft-sign-in.ts';

const WORK_TENANT = '11111111-2222-3333-4444-555555555555';

function azure(customClaims: Record<string, unknown>, at = '2026-10-19T10:00:00Z', email = 'pat@example.com') {
  return {
    provider: 'azure',
    last_sign_in_at: at,
    identity_data: { email, custom_claims: { tid: WORK_TENANT, ...customClaims } },
  };
}
function google(at = '2026-10-01T10:00:00Z') {
  return { provider: 'google', last_sign_in_at: at, identity_data: { email: 'pat@example.com', email_verified: true } };
}
function emailIdentity(at = '2026-09-01T10:00:00Z') {
  return { provider: 'email', last_sign_in_at: at, identity_data: { email: 'pat@example.com' } };
}

test('xms_edov true (boolean or string) passes; false, missing or junk is refused', () => {
  for (const edov of [true, 'true', 'TRUE', '1']) {
    assert.equal(isMicrosoftEmailVerified({ email: 'a@b.co', custom_claims: { xms_edov: edov, tid: WORK_TENANT } }), true, String(edov));
  }
  for (const edov of [false, 'false', '0', 0, 1, null, undefined, {}]) {
    assert.equal(isMicrosoftEmailVerified({ email: 'a@b.co', custom_claims: { xms_edov: edov, tid: WORK_TENANT } }), false, String(edov));
  }
  // Supabase itself treats a MISSING claim as verified. The guard does not:
  // a tenant that never configured the optional claim proves nothing.
  assert.equal(isMicrosoftEmailVerified({ email: 'a@b.co', custom_claims: { tid: WORK_TENANT } }), false);
});

test('a personal Microsoft account is verified by its tenant; an empty email never is', () => {
  assert.equal(isMicrosoftEmailVerified({ email: 'a@outlook.com', custom_claims: { tid: MICROSOFT_CONSUMER_TENANT_ID } }), true);
  assert.equal(isMicrosoftEmailVerified({ email: '', custom_claims: { xms_edov: true } }), false);
  assert.equal(isMicrosoftEmailVerified({ custom_claims: { xms_edov: true } }), false);
  assert.equal(isMicrosoftEmailVerified(null), false);
  // A tenant id in the wrong place or of the wrong type does not count.
  assert.equal(isMicrosoftEmailVerified({ email: 'a@b.co', custom_claims: { tid: [MICROSOFT_CONSUMER_TENANT_ID] } }), false);
});

test('the guard looks at the identity this sign-in used: the newest last_sign_in_at', () => {
  const user = { identities: [google('2026-10-19T09:00:00Z'), azure({}, '2026-10-19T10:00:00Z')] };
  assert.equal(signedInIdentity(user)?.provider, 'azure');
  assert.equal(microsoftSignInRefusal(user), 'microsoft_email_unverified');
});

test('an existing user signing in with Google is never refused over an old Microsoft identity', () => {
  const user = { identities: [azure({}, '2026-10-01T10:00:00Z'), google('2026-10-19T10:00:00Z')] };
  assert.equal(microsoftSignInRefusal(user), null);
});

test('a verified Microsoft sign-in linked to an existing email account passes', () => {
  const user = {
    app_metadata: { provider: 'email' },
    identities: [emailIdentity(), azure({ xms_edov: true })],
  };
  assert.equal(microsoftSignInRefusal(user), null);
});

test('no identities: refused only when the account is a Microsoft one', () => {
  assert.equal(microsoftSignInRefusal({ app_metadata: { provider: 'azure' }, identities: [] }), 'microsoft_email_unverified');
  assert.equal(microsoftSignInRefusal({ app_metadata: { provider: 'google' }, identities: [] }), null);
  assert.equal(microsoftSignInRefusal(null), null);
  assert.equal(microsoftSignInRefusal(undefined), null);
});

test('OAuth error redirects map to named reasons', () => {
  const p = (q: string) => oauthErrorReason(new URLSearchParams(q));
  assert.equal(p('error=invalid_request&error_description=AADSTS65001%3A+The+user+or+administrator+has+not+consented'), 'microsoft_admin_approval');
  assert.equal(p('error=access_denied&error_description=AADSTS90094%3A+Admin+consent+is+required'), 'microsoft_admin_approval');
  assert.equal(p('error=access_denied&error_description=Need+admin+approval'), 'microsoft_admin_approval');
  assert.equal(p('error=access_denied&error_description=AADSTS65004%3A+User+declined+to+consent'), 'oauth_cancelled');
  assert.equal(p('error=access_denied&error_description=The+user+cancelled'), 'oauth_cancelled');
  assert.equal(p('error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email'), 'provider_email_unverified');
  // Supabase's own denials are not a cancel.
  assert.equal(p('error=access_denied&error_code=user_banned'), null);
  assert.equal(p('error=access_denied&error_code=signup_disabled'), null);
  assert.equal(p('error=server_error&error_description=boom'), null);
  assert.equal(p(''), null);
});

test('linking an identity never provisions a workspace: the only provisioning trigger is AFTER INSERT ON auth.users', () => {
  // Supabase links a verified same-email sign-in by inserting a row into
  // auth.identities for the existing user; auth.users gets no new row. So the
  // existing account is reused and no second workspace appears, as long as no
  // migration hangs workspace creation off auth.identities.
  const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../supabase/migrations');
  const sql = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(path.join(migrations, f), 'utf8'))
    .join('\n');
  assert.equal(/ON\s+auth\.identities/i.test(sql), false);
  assert.match(sql, /AFTER\s+INSERT\s+ON\s+auth\.users\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\.handle_new_user/i);
});
