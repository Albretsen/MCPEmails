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
