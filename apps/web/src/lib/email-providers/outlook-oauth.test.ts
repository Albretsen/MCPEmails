import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTLOOK_SCOPES,
  shouldForceConsent,
  classifyMicrosoftAuthError,
  outlookTenant,
  outlookAuthorizeEndpoint,
  outlookTokenEndpoint,
  outlookAdminConsentEndpoint,
  ADMIN_CONSENT_STATE_PREFIX,
  isAdminConsentState,
  isAdminConsentCallback,
  classifyAdminConsentCallback,
  selectOutlookEmail,
  classifyOutlookProbe,
  settleOutlookProbe,
  OUTLOOK_NO_MAILBOX_REASON,
} from './outlook-oauth.ts';

// ─── prompt=consent ───────────────────────────────────────────────────────────

test('first connect does not force the consent screen', () => {
  // Regression guard. This was unconditionally true, which broke sign-in for
  // ordinary employees in tenants that had ALREADY granted admin consent:
  // prompt=consent makes Microsoft re-ask the individual user, and a non-admin
  // user is not allowed to answer. The tenant was consented and every employee
  // was still turned away.
  assert.equal(shouldForceConsent(false), false);
});

test('reconnect forces the consent screen', () => {
  // Re-consent is the only way to pick up a widened scope set: a silent refresh
  // keeps whatever scopes were originally granted.
  assert.equal(shouldForceConsent(true), true);
});

// ─── scopes ───────────────────────────────────────────────────────────────────

test('offline_access is requested, so a refresh token is issued', () => {
  // Without this the connection dies at the first access-token expiry and the
  // only recovery is a full interactive reconnect.
  assert.ok(OUTLOOK_SCOPES.includes('offline_access'));
});

test('Mail.Send is requested separately from Mail.ReadWrite', () => {
  // Mail.ReadWrite is a superset of Mail.Read but does NOT grant sending.
  assert.ok(OUTLOOK_SCOPES.includes('Mail.ReadWrite'));
  assert.ok(OUTLOOK_SCOPES.includes('Mail.Send'));
});

// ─── callback error classification ────────────────────────────────────────────

test('no error reported classifies as null', () => {
  assert.equal(classifyMicrosoftAuthError(null, null), null);
});

test('explicit consent_required is an admin consent problem', () => {
  assert.equal(
    classifyMicrosoftAuthError('consent_required', null),
    'admin_consent_required',
  );
});

test('interaction_required is an admin consent problem', () => {
  assert.equal(
    classifyMicrosoftAuthError('interaction_required', null),
    'admin_consent_required',
  );
});

test('AADSTS65001 in the description outranks a bare access_denied', () => {
  // The important asymmetry. Microsoft reports a tenant policy block as
  // access_denied carrying AADSTS65001. Reading only the error code would file
  // it as the user cancelling, which is both wrong and quietly damaging: it
  // reads in the funnel as people rejecting the product, when in fact they were
  // never given a choice.
  assert.equal(
    classifyMicrosoftAuthError(
      'access_denied',
      'AADSTS65001: The user or administrator has not consented to use the application.',
    ),
    'admin_consent_required',
  );
});

test('AADSTS900971 is treated as an admin consent problem', () => {
  assert.equal(
    classifyMicrosoftAuthError('invalid_grant', 'AADSTS900971: No reply address provided.'),
    'admin_consent_required',
  );
});

test('a genuine user cancellation is still reported as a cancellation', () => {
  // The other side of the asymmetry above: a real denial must not be laundered
  // into an admin problem, or we would tell people to go bother their IT
  // department because they clicked Cancel.
  assert.equal(
    classifyMicrosoftAuthError('access_denied', 'AADSTS65004: User declined to consent.'),
    'cancelled',
  );
});

test('an unrecognised error falls back to the generic code', () => {
  assert.equal(
    classifyMicrosoftAuthError('server_error', 'AADSTS50011: redirect URI mismatch'),
    'oauth_error',
  );
});

test('an empty description never crashes the classifier', () => {
  assert.equal(classifyMicrosoftAuthError('server_error', ''), 'oauth_error');
});

// ─── authority ────────────────────────────────────────────────────────────────

test('tenant defaults to common and ignores anything that is not a plain id', () => {
  assert.equal(outlookTenant(undefined), 'common');
  assert.equal(outlookTenant(''), 'common');
  assert.equal(outlookTenant('  '), 'common');
  assert.equal(outlookTenant('../evil?x='), 'common');
  assert.equal(outlookTenant('72f988bf-86f1-41af-91ab-2d7cd011db47'), '72f988bf-86f1-41af-91ab-2d7cd011db47');
  assert.equal(outlookTenant('contoso.onmicrosoft.com'), 'contoso.onmicrosoft.com');
});

test('authorize and token endpoints share one authority', () => {
  assert.equal(outlookAuthorizeEndpoint('common'), 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(outlookTokenEndpoint('common'), 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
});

test('admin consent uses organizations unless a tenant is pinned', () => {
  assert.equal(outlookAdminConsentEndpoint('common'), 'https://login.microsoftonline.com/organizations/v2.0/adminconsent');
  assert.equal(outlookAdminConsentEndpoint('consumers'), 'https://login.microsoftonline.com/organizations/v2.0/adminconsent');
  assert.equal(outlookAdminConsentEndpoint('contoso.com'), 'https://login.microsoftonline.com/contoso.com/v2.0/adminconsent');
});

// ─── admin consent callback ───────────────────────────────────────────────────

const acState = `${ADMIN_CONSENT_STATE_PREFIX}abc`;

test('an admin-consent success is recognised and classified as granted', () => {
  const params = new URLSearchParams({ admin_consent: 'True', tenant: 'tid', state: acState });
  assert.equal(isAdminConsentCallback(params), true);
  assert.equal(classifyAdminConsentCallback(params), 'admin_consent_granted');
});

test('an admin-consent error is recognised by its state even without admin_consent', () => {
  // Microsoft's error response carries error/error_description/state only, so
  // without the state prefix it would be read as a failed mailbox connection.
  const params = new URLSearchParams({ error: 'access_denied', error_description: 'AADSTS65004: declined', state: acState });
  assert.equal(isAdminConsentCallback(params), true);
  assert.equal(classifyAdminConsentCallback(params), 'admin_consent_cancelled');
});

test('any other admin-consent error is a failure, never granted', () => {
  const params = new URLSearchParams({ error: 'invalid_request', error_description: 'AADSTS50011: redirect', state: acState });
  assert.equal(classifyAdminConsentCallback(params), 'admin_consent_failed');
  assert.equal(
    classifyAdminConsentCallback(new URLSearchParams({ admin_consent: 'False', state: acState })),
    'admin_consent_failed',
  );
});

test('an ordinary connect callback is not mistaken for admin consent', () => {
  assert.equal(isAdminConsentCallback(new URLSearchParams({ code: 'c', state: 'plainstate' })), false);
  assert.equal(isAdminConsentCallback(new URLSearchParams({ error: 'access_denied', state: 'plainstate' })), false);
  assert.equal(isAdminConsentState('plainstate'), false);
  assert.equal(isAdminConsentState(null), false);
});

// ─── email selection ──────────────────────────────────────────────────────────

test('the email claim wins over preferred_username (the UPN)', () => {
  assert.equal(
    selectOutlookEmail({ email: 'first.last@corp.example', preferred_username: 'flast@corp.example' }),
    'first.last@corp.example',
  );
});

test('the address is lowercased and trimmed', () => {
  assert.equal(selectOutlookEmail({ email: '  Jane@Outlook.COM ' }), 'jane@outlook.com');
});

test('preferred_username is the fallback when email is absent or unusable', () => {
  assert.equal(selectOutlookEmail({ preferred_username: 'Jane@Hotmail.com' }), 'jane@hotmail.com');
  assert.equal(selectOutlookEmail({ email: '', preferred_username: 'jane@hotmail.com' }), 'jane@hotmail.com');
  assert.equal(selectOutlookEmail({ email: 'nope', preferred_username: 'jane@hotmail.com' }), 'jane@hotmail.com');
});

test('no usable address gives null rather than a broken inbox key', () => {
  assert.equal(selectOutlookEmail({}), null);
  assert.equal(selectOutlookEmail({ preferred_username: '+4712345678' }), null);
  assert.equal(selectOutlookEmail({ email: 42, preferred_username: 'no-at-sign' }), null);
  assert.equal(selectOutlookEmail({ email: 'a@b' }), null);
});

// ─── live probe classification ────────────────────────────────────────────────

test('probe classification: only 401 means reconnect', () => {
  assert.equal(classifyOutlookProbe(200, null), 'ok');
  assert.equal(classifyOutlookProbe(401, 'InvalidAuthenticationToken'), 'unauthorized');
  assert.equal(classifyOutlookProbe(403, 'ErrorAccessDenied'), 'forbidden');
  assert.equal(classifyOutlookProbe(404, 'ResourceNotFound'), 'no_mailbox');
  assert.equal(classifyOutlookProbe(401, 'MailboxNotEnabledForRESTAPI'), 'no_mailbox');
  assert.equal(classifyOutlookProbe(429, null), 'inconclusive');
  assert.equal(classifyOutlookProbe(503, null), 'inconclusive');
});

// ─── 401 on a valid token: no mailbox, not reconnect (live 2026-09-25) ───────

test('ErrorMailboxNotFound is a missing mailbox', () => {
  assert.equal(classifyOutlookProbe(404, 'ErrorMailboxNotFound'), 'no_mailbox');
  assert.equal(classifyOutlookProbe(401, 'ErrorMailboxNotFound'), 'no_mailbox');
});

test('a plain 401 on a stored token asks for ONE refresh and a retry', () => {
  assert.equal(settleOutlookProbe('unauthorized', false), 'refresh_and_retry');
});

test('a plain 401 on a token minted just now is no mailbox, never reconnect', () => {
  // An Entra account without an Exchange Online mailbox gets a valid token and
  // a 401 with an empty body on /me/mailFolders/inbox, even after a refresh.
  assert.equal(settleOutlookProbe('unauthorized', true), 'no_mailbox');
});

test('every other probe result passes through unchanged', () => {
  for (const r of ['ok', 'no_mailbox', 'forbidden', 'inconclusive'] as const) {
    assert.equal(settleOutlookProbe(r, false), r);
    assert.equal(settleOutlookProbe(r, true), r);
  }
});

test('the no-mailbox reason points at IMAP and never says reconnect', () => {
  assert.match(OUTLOOK_NO_MAILBOX_REASON, /IMAP/);
  assert.match(OUTLOOK_NO_MAILBOX_REASON, /Reconnecting will not change this/);
  assert.doesNotMatch(OUTLOOK_NO_MAILBOX_REASON, /please reconnect/i);
});

// ─── Shareable admin-consent link (outlook-admin-link.ts) ─────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_CONSENT_LINK_TTL_MS,
  ADMIN_CONSENT_RESULT_STATUSES,
  deriveAdminConsentLinkKey,
  signAdminConsentLinkToken,
  mintAdminConsentLinkToken,
  verifyAdminConsentLinkToken,
  adminConsentLinkUrl,
  adminConsentResultUrl,
  adminConsentCallbackRedirect,
  isAdminConsentResultStatus,
  stateCookieMatches,
} from './outlook-admin-link.ts';

const LINK_SECRET = 'a1'.repeat(32);
const OTHER_SECRET = 'b2'.repeat(32);
const WS = '5a3c1d2e-1111-4a2b-9c3d-0123456789ab';
const USER = '0f9e8d7c-2222-4b3a-8d4c-ba9876543210';
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

test('a minted admin link verifies and carries the workspace, user and a 7-day expiry', () => {
  const key = deriveAdminConsentLinkKey(LINK_SECRET);
  const { token, expiresAt } = mintAdminConsentLinkToken(WS, USER, key, NOW);
  assert.equal(expiresAt, NOW + ADMIN_CONSENT_LINK_TTL_MS);
  assert.equal(ADMIN_CONSENT_LINK_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  const result = verifyAdminConsentLinkToken(token, key, NOW + 1000);
  assert.deepEqual(result, { ok: true, workspaceId: WS, userId: USER, expiresAt });
});

test('the admin link token is URL-safe and short enough to paste', () => {
  const key = deriveAdminConsentLinkKey(LINK_SECRET);
  const { token } = mintAdminConsentLinkToken(WS, USER, key, NOW);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(token.length < 100, `token is ${token.length} chars`);
  const url = adminConsentLinkUrl('https://mcpemails.com/', token);
  assert.equal(url, `https://mcpemails.com/auth/outlook/admin-consent?t=${token}`);
});

test('an admin link stays reusable until it expires, then reports expired', () => {
  const key = deriveAdminConsentLinkKey(LINK_SECRET);
  const { token, expiresAt } = mintAdminConsentLinkToken(WS, USER, key, NOW);
  assert.equal(verifyAdminConsentLinkToken(token, key, expiresAt - 1000).ok, true);
  assert.equal(verifyAdminConsentLinkToken(token, key, expiresAt - 1000).ok, true, 'a second open still works');
  assert.deepEqual(verifyAdminConsentLinkToken(token, key, expiresAt), { ok: false, reason: 'expired' });
});

test('a tampered admin link is refused as a bad signature, never as expired or valid', () => {
  const key = deriveAdminConsentLinkKey(LINK_SECRET);
  const { token } = mintAdminConsentLinkToken(WS, USER, key, NOW);
  const [payload, sig] = token.split('.');
  // Swap the workspace for another one, keeping the original signature.
  const forged = signAdminConsentLinkToken(
    { workspaceId: '99999999-9999-4999-8999-999999999999', userId: USER, expiresAt: NOW + 3600_000 },
    deriveAdminConsentLinkKey(OTHER_SECRET),
  );
  const forgedWithOldSig = `${forged.split('.')[0]}.${sig}`;
  assert.deepEqual(verifyAdminConsentLinkToken(forgedWithOldSig, key, NOW), { ok: false, reason: 'bad_signature' });
  // Flip one byte of the payload (the expiry): an extended link must not pass.
  const bytes = Buffer.from(payload, 'base64url');
  bytes[36] ^= 0xff;
  assert.deepEqual(
    verifyAdminConsentLinkToken(`${bytes.toString('base64url')}.${sig}`, key, NOW),
    { ok: false, reason: 'bad_signature' },
  );
  // A token signed with another secret is refused.
  assert.deepEqual(verifyAdminConsentLinkToken(forged, key, NOW), { ok: false, reason: 'bad_signature' });
  // A signature check precedes the expiry check: an expired forgery is still a forgery.
  assert.deepEqual(verifyAdminConsentLinkToken(forgedWithOldSig, key, NOW + 30 * 86400_000), { ok: false, reason: 'bad_signature' });
});

test('malformed admin link tokens are refused without throwing', () => {
  const key = deriveAdminConsentLinkKey(LINK_SECRET);
  for (const bad of [null, undefined, '', 'abc', 'a.b.c', 'a.b', '!!.??', 'x'.repeat(500)]) {
    const result = verifyAdminConsentLinkToken(bad as string, key, NOW);
    assert.equal(result.ok, false, String(bad));
  }
});

test('the link key is derived from CSRF_SECRET under its own label, and refuses a bad secret', () => {
  const key = deriveAdminConsentLinkKey(LINK_SECRET);
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, Buffer.from(LINK_SECRET, 'hex'), 'never the raw CSRF key');
  assert.throws(() => deriveAdminConsentLinkKey(undefined));
  assert.throws(() => deriveAdminConsentLinkKey('short'));
  assert.throws(() => deriveAdminConsentLinkKey('zz'.repeat(32)));
});

test('the state cookie must equal the returned state exactly', () => {
  assert.equal(stateCookieMatches('ac.abc', 'ac.abc'), true);
  assert.equal(stateCookieMatches('ac.abc', 'ac.abd'), false);
  assert.equal(stateCookieMatches(null, 'ac.abc'), false);
  assert.equal(stateCookieMatches('ac.abc', null), false);
  assert.equal(stateCookieMatches('ac.ab', 'ac.abc'), false);
});

// ─── Public callback result ───────────────────────────────────────────────────

const APP = 'https://mcpemails.com';

test('an admin without a session lands on the public result page, not the dashboard', () => {
  const granted = adminConsentCallbackRedirect({ appUrl: APP, outcome: 'admin_consent_granted', sessionUserId: null, inviterUserId: USER });
  assert.equal(granted, `${APP}/auth/outlook/admin-consent/result?status=granted`);
  assert.equal(
    adminConsentCallbackRedirect({ appUrl: APP, outcome: 'admin_consent_cancelled', sessionUserId: null, inviterUserId: USER }),
    `${APP}/auth/outlook/admin-consent/result?status=cancelled`,
  );
  assert.equal(
    adminConsentCallbackRedirect({ appUrl: APP, outcome: 'admin_consent_failed', sessionUserId: null, inviterUserId: USER }),
    `${APP}/auth/outlook/admin-consent/result?status=failed`,
  );
});

test('an admin signed in to a DIFFERENT MCP Emails account still gets the public page', () => {
  const url = adminConsentCallbackRedirect({ appUrl: APP, outcome: 'admin_consent_granted', sessionUserId: WS, inviterUserId: USER });
  assert.ok(url.includes('/auth/outlook/admin-consent/result?status=granted'));
});

test('the inviter approving their own link returns to the dashboard toasts', () => {
  const at = (outcome: 'admin_consent_granted' | 'admin_consent_cancelled' | 'admin_consent_failed') =>
    adminConsentCallbackRedirect({ appUrl: APP, outcome, sessionUserId: USER, inviterUserId: USER });
  assert.equal(at('admin_consent_granted'), `${APP}/dashboard?admin_consent=granted`);
  assert.equal(at('admin_consent_cancelled'), `${APP}/dashboard?error=cancelled`);
  assert.equal(at('admin_consent_failed'), `${APP}/dashboard?error=admin_consent_failed`);
});

test('result statuses are a closed set; anything else is not one', () => {
  for (const status of ADMIN_CONSENT_RESULT_STATUSES) {
    assert.equal(isAdminConsentResultStatus(status), true);
    assert.ok(adminConsentResultUrl(APP, status).endsWith(`?status=${status}`));
  }
  assert.equal(isAdminConsentResultStatus('granted<script>'), false);
  assert.equal(isAdminConsentResultStatus(undefined), false);
});

test('every locale has the admin-link dialog, every result status and the Microsoft-address copy', () => {
  const webRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const en = JSON.parse(readFileSync(`${webRoot}messages/en/dashboardChrome.json`, 'utf8'));
  const linkKeys = Object.keys(en.adminConsentLink);
  for (const locale of ['en', 'es', 'fr', 'nb', 'zh']) {
    const m = JSON.parse(readFileSync(`${webRoot}messages/${locale}/dashboardChrome.json`, 'utf8'));
    for (const key of linkKeys) assert.ok(m.adminConsentLink?.[key], `${locale} adminConsentLink.${key}`);
    for (const status of ADMIN_CONSENT_RESULT_STATUSES) {
      assert.ok(m.adminConsentResult?.[`${status}Title`], `${locale} ${status}Title`);
      assert.ok(m.adminConsentResult?.[`${status}Body`], `${locale} ${status}Body`);
    }
    for (const key of ['adminConsentAction', 'adminConsentFailed', 'adminConsentFailedAction', 'adminConsentGranted']) {
      assert.ok(m.app?.[key], `${locale} app.${key}`);
    }
    for (const key of ['hintOutlook', 'outlookAdminLink', 'microsoftAddressNotice', 'microsoftAddressAction', 'errorMicrosoftAccountShort']) {
      assert.ok(m.connect?.[key], `${locale} connect.${key}`);
    }
    assert.equal(m.connect.comingSoon, undefined, `${locale} connect.comingSoon was removed`);
    const text = JSON.stringify([m.adminConsentLink, m.adminConsentResult]);
    assert.ok(!/[—―]/.test(text), `${locale} has no em dashes in the new copy`);
  }
});
