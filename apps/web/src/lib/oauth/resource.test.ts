// ---------------------------------------------------------------------------
// RFC 8707 resource indicator validation for the OAuth authorization server.
//
// The cases that matter: an absent parameter must keep working (older MCP
// clients never send one); the canonical MCP endpoint must be accepted under
// harmless spelling variation; every other target must be `invalid_target`;
// and redemption must refuse a token request whose resource disagrees with
// the one the grant was issued for, while tolerating absence on either side.
//
// Run: node --test --experimental-strip-types src/lib/oauth/resource.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalResource,
  MCP_RESOURCE_PATH,
  OAUTH_INVALID_TARGET,
  resourceMatchesGrant,
  validateResourceIndicator,
} from './resource.ts';

const CANON = 'https://mcpemails.com/api/mcp';

test('canonical resource is the app origin plus the MCP path', () => {
  assert.equal(MCP_RESOURCE_PATH, '/api/mcp');
  assert.ok(canonicalResource().endsWith(MCP_RESOURCE_PATH));
  assert.ok(canonicalResource().startsWith('http'));
});

test('absent, null, and empty resource are accepted and recorded as null', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.deepEqual(validateResourceIndicator(raw, CANON), { ok: true, resource: null });
  }
});

test('the canonical resource is accepted verbatim', () => {
  assert.deepEqual(validateResourceIndicator(CANON, CANON), { ok: true, resource: CANON });
});

test('harmless spelling variation of the canonical resource is accepted', () => {
  for (const raw of [
    'HTTPS://MCPEMAILS.COM/api/mcp',
    'https://mcpemails.com:443/api/mcp',
    'https://mcpemails.com/api/mcp/',
    '  https://mcpemails.com/api/mcp  ',
  ]) {
    const r = validateResourceIndicator(raw, CANON);
    assert.equal(r.ok, true, raw);
    if (r.ok) assert.equal(r.resource, CANON);
  }
});

test('a resource this server does not serve is invalid_target', () => {
  for (const raw of [
    'https://evil.example/mcp',
    'https://mcpemails.com/',
    'https://mcpemails.com/api',
    'https://mcpemails.com/api/mcp/extra',
    'https://mcpemails.com/api/mcp?x=1',
    'http://mcpemails.com/api/mcp',
    'https://www.mcpemails.com/api/mcp',
    'https://mcpemails.com.evil.example/api/mcp',
  ]) {
    const r = validateResourceIndicator(raw, CANON);
    assert.equal(r.ok, false, raw);
    if (!r.ok) assert.equal(r.error, OAUTH_INVALID_TARGET);
  }
});

test('non-URI, relative, non-http and fragment-bearing values are invalid_target', () => {
  for (const raw of ['mcp', '/api/mcp', 'mcpemails.com/api/mcp', 'claude://oauth', 'https://mcpemails.com/api/mcp#frag']) {
    const r = validateResourceIndicator(raw, CANON);
    assert.equal(r.ok, false, raw);
    if (!r.ok) assert.equal(r.error, OAUTH_INVALID_TARGET);
  }
});

test('a non-string (e.g. an array from a JSON body) is invalid_target', () => {
  const r = validateResourceIndicator([CANON, CANON], CANON);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, OAUTH_INVALID_TARGET);
});

test('the canonical comparison follows the configured origin', () => {
  const other = 'https://staging.mcpemails.com/api/mcp';
  assert.equal(validateResourceIndicator(other, other).ok, true);
  assert.equal(validateResourceIndicator(CANON, other).ok, false);
});

test('redemption accepts matching resources and absence on either side', () => {
  assert.equal(resourceMatchesGrant(CANON, CANON), true);
  assert.equal(resourceMatchesGrant(null, CANON), true);
  assert.equal(resourceMatchesGrant(CANON, null), true);
  assert.equal(resourceMatchesGrant(null, null), true);
});

test('redemption refuses a resource that differs from the grant', () => {
  assert.equal(resourceMatchesGrant('https://evil.example/mcp', CANON), false);
  assert.equal(resourceMatchesGrant(CANON, 'https://staging.mcpemails.com/api/mcp'), false);
});
