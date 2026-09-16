/**
 * The discovery documents, and the one invariant that keeps the identity
 * scopes honest: they must grant nothing.
 *
 * The OIDC surface exists for a single reason (a ChatGPT Business or
 * Enterprise admin restricting this connector to their own email domain), and
 * the way it goes wrong is not a broken endpoint but a scope that quietly
 * becomes a tool permission, or a document that drifts from the RFC 8414 one
 * every MCP client actually reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_SCOPES,
  TOOL_SCOPES,
  authorizationServerMetadata,
  openIdConfiguration,
} from './metadata.ts';
import { VALID_SCOPES } from '../api-keys/scopes.ts';

const BASE = 'https://example.test';

test('an identity scope is never a grantable tool scope', () => {
  // If one of these ever lands in VALID_SCOPES it becomes selectable on the
  // consent screen and storable on a dashboard key, and "openid" would start
  // reading as a permission over the mailbox. It authorizes claims, nothing
  // else.
  for (const scope of IDENTITY_SCOPES) {
    assert.ok(
      !(VALID_SCOPES as readonly string[]).includes(scope),
      `${scope} must not be in the api-keys VALID_SCOPES`,
    );
    assert.ok(!(TOOL_SCOPES as readonly string[]).includes(scope));
  }
});

test('the authorization server advertises the userinfo endpoint and both identity scopes', () => {
  const metadata = authorizationServerMetadata(BASE);
  assert.equal(metadata.userinfo_endpoint, `${BASE}/api/oauth/userinfo`);
  for (const scope of IDENTITY_SCOPES) {
    assert.ok(metadata.scopes_supported.includes(scope), `${scope} must be advertised`);
  }
  // Every tool scope still advertised: the identity scopes are an addition,
  // not a replacement, and a client that lost one would silently lose access.
  for (const scope of TOOL_SCOPES) {
    assert.ok(metadata.scopes_supported.includes(scope), `${scope} must stay advertised`);
  }
});

test('the OIDC document is the same authorization server, not a second one', () => {
  const oauth = authorizationServerMetadata(BASE);
  const oidc = openIdConfiguration(BASE);
  for (const field of [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'registration_endpoint',
    'revocation_endpoint',
    'userinfo_endpoint',
  ] as const) {
    assert.equal(oidc[field], oauth[field], `${field} must not drift between the two documents`);
  }
  assert.deepEqual(oidc.scopes_supported, oauth.scopes_supported);
});

test('the OIDC document promises no ID token', () => {
  // We sign nothing and publish no JWKS. Advertising an id_token response type
  // or a signing algorithm would point a client at a key that does not exist.
  const oidc = openIdConfiguration(BASE) as Record<string, unknown>;
  assert.deepEqual(oidc.response_types_supported, ['code']);
  assert.equal(oidc.jwks_uri, undefined);
  assert.equal(oidc.id_token_signing_alg_values_supported, undefined);
  assert.deepEqual(oidc.claims_supported, ['sub', 'email', 'email_verified']);
});
