// ---------------------------------------------------------------------------
// Client ID Metadata Documents: the pure logic that decides whether a
// self-asserted document is allowed to be an OAuth client here.
//
// Every case below is a way the check could be wrong in a way that hands
// somebody else's authorization codes to an attacker, which is why they are
// worth more than the happy path:
//
//   - an http:// client_id (the document is rewritable in transit)
//   - a document whose client_id names a URL other than the one it was served
//     from (anyone could claim to be anyone)
//   - a redirect_uri on an origin the client_id does not own
//   - a loopback redirect matched too loosely (wrong host) or too strictly
//     (right host, ephemeral port), which is the difference between breaking
//     every native client and authorising the wrong one
//
// The fetch itself is not exercised here: it is an outbound HTTPS request and
// these tests must not touch the network. What is testable without a socket is
// tested, and the SSRF guard behind the fetch has its own suite
// (src/lib/email/host-guard.test.ts, exercised through guardHttpHost).
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/oauth/cimd.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CIMD_SCOPES,
  cimdDisplayHost,
  isLoopbackRedirectUri,
  listedRedirectUriAcceptable,
  looksLikeUrlClientId,
  normalizeCimdClientId,
  parseCimdClientId,
  redirectUriAllowed,
  validateCimdDocument,
} from './cimd.ts';

const CLIENT_ID = 'https://claude.ai/api/mcp/cimd';

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...overrides,
  };
}

/* ── client_id shape ─────────────────────────────────────────────────────── */

test('a registered client id is not mistaken for a URL', () => {
  assert.equal(looksLikeUrlClientId('claude-desktop'), false);
  assert.equal(looksLikeUrlClientId('dyn_9f2c1a4b7e8d0c3f5a6b2d1e'), false);
  assert.equal(looksLikeUrlClientId(''), false);
  assert.equal(looksLikeUrlClientId(undefined), false);
});

test('http and https client ids both route to the CIMD branch, so http gets a real reason', () => {
  // The branch has to catch http too. Sending it down the registered-client
  // path would answer "unknown application" and hide why it was refused.
  assert.equal(looksLikeUrlClientId('http://evil.example/doc'), true);
  assert.equal(looksLikeUrlClientId('https://claude.ai/doc'), true);
});

test('an http client_id is rejected outright', () => {
  const result = parseCimdClientId('http://claude.ai/api/mcp/cimd');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'not_https');
});

test('a non-http scheme is not a client id URL', () => {
  for (const bad of ['ftp://claude.ai/doc', 'claude://oauth/callback', 'file:///etc/passwd']) {
    const result = parseCimdClientId(bad);
    assert.equal(result.ok, false, bad);
  }
});

test('credentials, fragments and non-443 ports are refused', () => {
  for (const bad of [
    'https://user:pw@claude.ai/doc',
    'https://claude.ai/doc#frag',
    'https://claude.ai:8443/doc',
    'https://claude.ai:22/doc',
  ]) {
    const result = parseCimdClientId(bad);
    assert.equal(result.ok, false, bad);
    assert.equal(result.ok === false && result.code, 'bad_url_shape', bad);
  }
});

test('an explicit :443 is the default port, not a custom one', () => {
  const result = parseCimdClientId('https://claude.ai:443/api/mcp/cimd');
  assert.equal(result.ok, true);
  assert.equal(result.ok === true && result.value.normalized, CLIENT_ID);
});

test('scheme and host case-fold, path and query do not', () => {
  assert.equal(normalizeCimdClientId(new URL('HTTPS://Claude.AI/API/Mcp')), 'https://claude.ai/API/Mcp');
  assert.equal(normalizeCimdClientId(new URL('https://claude.ai/d?b=2&a=1')), 'https://claude.ai/d?b=2&a=1');
});

test('a garbage or oversized client_id is refused rather than fetched', () => {
  assert.equal(parseCimdClientId('not a url').ok, false);
  assert.equal(parseCimdClientId(42).ok, false);
  assert.equal(parseCimdClientId(`https://claude.ai/${'a'.repeat(4000)}`).ok, false);
});

/* ── self-reference ──────────────────────────────────────────────────────── */

test('a self-referential document is accepted', () => {
  const result = validateCimdDocument(doc(), CLIENT_ID);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true && result.value, {
    client_id: CLIENT_ID,
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  });
});

test('a document whose client_id disagrees with its URL is rejected', () => {
  // The whole attack: host a document at your own URL that claims to be
  // Claude's client_id, and codes meant for Claude get bound to it.
  const result = validateCimdDocument(doc({ client_id: 'https://claude.ai/api/mcp/other' }), CLIENT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'not_self_referential');
});

test('a document claiming another origin entirely is rejected', () => {
  const result = validateCimdDocument(doc({ client_id: 'https://evil.example/doc' }), CLIENT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'not_self_referential');
});

test('a document with a missing or non-https client_id is rejected', () => {
  for (const bad of [undefined, null, '', 'http://claude.ai/api/mcp/cimd', 123]) {
    const result = validateCimdDocument(doc({ client_id: bad }), CLIENT_ID);
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.ok === false && result.code, 'not_self_referential', String(bad));
  }
});

test('the self-reference check tolerates harmless spelling of the same URL', () => {
  const result = validateCimdDocument(doc({ client_id: 'HTTPS://Claude.ai:443/api/mcp/cimd' }), CLIENT_ID);
  assert.equal(result.ok, true);
});

test('a body that is not a JSON object is rejected', () => {
  for (const bad of [null, [], 'string', 7]) {
    const result = validateCimdDocument(bad, CLIENT_ID);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'not_json');
  }
});

/* ── declared capabilities ───────────────────────────────────────────────── */

test('a confidential client is refused: we have no secret to verify', () => {
  const result = validateCimdDocument(doc({ token_endpoint_auth_method: 'client_secret_basic' }), CLIENT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'unsupported_auth_method');
});

test('omitting the optional declarations is fine', () => {
  const bare = { client_id: CLIENT_ID, redirect_uris: ['https://claude.ai/cb'] };
  assert.equal(validateCimdDocument(bare, CLIENT_ID).ok, true);
});

test('a document that declares grants but not authorization_code is refused', () => {
  assert.equal(validateCimdDocument(doc({ grant_types: ['client_credentials'] }), CLIENT_ID).ok, false);
  assert.equal(validateCimdDocument(doc({ response_types: ['token'] }), CLIENT_ID).ok, false);
});

/* ── redirect_uri: what a document may list ──────────────────────────────── */

test('only same-origin https may be listed, except loopback', () => {
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'https://claude.ai/cb'), true);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'https://evil.example/cb'), false);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'https://sub.claude.ai/cb'), false);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'https://claude.ai:8443/cb'), false);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'http://claude.ai/cb'), false);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'claude://oauth/callback'), false);
});

test('loopback http may be listed by any client_id origin', () => {
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'http://127.0.0.1:8765/cb'), true);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'http://[::1]:8765/cb'), true);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'http://localhost:8765/cb'), true);
  // Not loopback, whatever it is named.
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'http://127.0.0.1.evil.example/cb'), false);
  assert.equal(listedRedirectUriAcceptable(CLIENT_ID, 'http://169.254.169.254/cb'), false);
});

test('an unusable entry is skipped, it does not poison the usable ones', () => {
  const result = validateCimdDocument(
    doc({ redirect_uris: ['claude://oauth/callback', 'https://evil.example/cb', 'https://claude.ai/cb'] }),
    CLIENT_ID
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true && result.value.redirect_uris, ['https://claude.ai/cb']);
});

test('a document with no usable redirect_uri at all is refused', () => {
  assert.equal(validateCimdDocument(doc({ redirect_uris: [] }), CLIENT_ID).ok, false);
  assert.equal(validateCimdDocument(doc({ redirect_uris: ['https://evil.example/cb'] }), CLIENT_ID).ok, false);
  assert.equal(validateCimdDocument(doc({ redirect_uris: 'https://claude.ai/cb' }), CLIENT_ID).ok, false);
});

/* ── redirect_uri: matching the request against the document ─────────────── */

test('a same-origin https redirect must match exactly', () => {
  const uris = ['https://claude.ai/api/mcp/auth_callback'];
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'https://claude.ai/api/mcp/auth_callback2'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'https://claude.ai/api/mcp/auth_callback?x=1'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'https://evil.example/api/mcp/auth_callback'), false);
  // The port is NOT free outside loopback.
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'https://claude.ai:8443/api/mcp/auth_callback'), false);
});

test('a loopback redirect matches with the port ignored (RFC 8252 7.3)', () => {
  const uris = ['http://127.0.0.1/callback'];
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://127.0.0.1:51234/callback'), true);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://127.0.0.1:8080/callback'), true);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://127.0.0.1/callback'), true);
});

test('the same port-agnostic rule applies to localhost, because Claude Code declares it', () => {
  const uris = ['http://localhost/callback'];
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://localhost:49813/callback'), true);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://localhost/callback'), true);
});

test('ignoring the port does not mean ignoring the host', () => {
  // A document that declared 127.0.0.1 has not authorised localhost, and a
  // document that declared localhost has not authorised some other machine.
  assert.equal(redirectUriAllowed(CLIENT_ID, ['http://127.0.0.1/cb'], 'http://localhost:5000/cb'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, ['http://localhost/cb'], 'http://127.0.0.1:5000/cb'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, ['http://127.0.0.1/cb'], 'http://10.0.0.7:5000/cb'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, ['http://[::1]/cb'], 'http://127.0.0.1:5000/cb'), false);
});

test('ignoring the port does not mean ignoring the path, query or scheme', () => {
  const uris = ['http://127.0.0.1/callback'];
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://127.0.0.1:51234/other'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://127.0.0.1:51234/callback?next=x'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'https://127.0.0.1:51234/callback'), false);
});

test('an IPv6 loopback redirect matches port-agnostically too', () => {
  const uris = ['http://[::1]/callback'];
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://[::1]:51234/callback'), true);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'http://[::1]/callback'), true);
});

test('a request with no redirect_uri, or a malformed one, is never allowed', () => {
  const uris = ['https://claude.ai/cb'];
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, ''), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, undefined), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, uris, 'not a uri'), false);
  assert.equal(redirectUriAllowed(CLIENT_ID, [], 'https://claude.ai/cb'), false);
});

test('isLoopbackRedirectUri names exactly the three loopback hosts over http', () => {
  assert.equal(isLoopbackRedirectUri('http://127.0.0.1:1/cb'), true);
  assert.equal(isLoopbackRedirectUri('http://[::1]:1/cb'), true);
  assert.equal(isLoopbackRedirectUri('http://localhost:1/cb'), true);
  assert.equal(isLoopbackRedirectUri('https://127.0.0.1:1/cb'), false);
  assert.equal(isLoopbackRedirectUri('http://example.com/cb'), false);
  assert.equal(isLoopbackRedirectUri('garbage'), false);
});

/* ── consent identity ────────────────────────────────────────────────────── */

test('the relying party shown is the host of the URL, never the self-asserted name', () => {
  assert.equal(cimdDisplayHost('https://claude.ai/api/mcp/cimd'), 'claude.ai');
  // A document is free to call itself anything. The host is what the user gets
  // to check, so the host is what the consent screen says.
  const impostor = validateCimdDocument(
    { client_id: 'https://evil.example/doc', client_name: 'Anthropic', redirect_uris: ['https://evil.example/cb'] },
    'https://evil.example/doc'
  );
  assert.equal(impostor.ok, true);
  assert.equal(cimdDisplayHost(impostor.ok === true ? impostor.value.client_id : ''), 'evil.example');
  // client_name is not even carried out of validation.
  assert.equal(impostor.ok === true && 'client_name' in impostor.value, false);
});

/* ── scope ceiling ───────────────────────────────────────────────────────── */

test('a CIMD client gets the same scope ceiling as a dynamically-registered one', () => {
  // Kept in step with DYNAMIC_SCOPES in app/api/oauth/register/route.ts. If
  // this list drifts, one registration path can ask for something the other
  // cannot and the consent screen stops being comparable between them.
  assert.deepEqual([...CIMD_SCOPES], [
    'read:email',
    'search:email',
    'send:email',
    'manage:folders',
    'delete:email',
    'manage:drafts',
    'manage:contacts',
    'schedule:email',
    'manage:automations',
  ]);
});
