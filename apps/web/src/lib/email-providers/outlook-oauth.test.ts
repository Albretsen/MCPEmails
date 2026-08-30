import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTLOOK_SCOPES,
  shouldForceConsent,
  classifyMicrosoftAuthError,
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
