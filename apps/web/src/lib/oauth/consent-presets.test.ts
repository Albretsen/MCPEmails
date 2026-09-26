// ---------------------------------------------------------------------------
// Which card the /authorize consent screen opens on.
//
// The case that produced this module is the first test: claude.ai now sends
// `scope=read:email` alone, and the screen used to answer that by preselecting
// "Standard", which adds send, drafts and contacts. Everything else here exists
// to pin the edges around it: a request that matches a wider preset, one that
// matches none, one carrying a scope we do not recognise, and the legacy
// no-`scope` request whose default must NOT change.
//
// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        src/lib/oauth/consent-presets.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCESS_PRESETS,
  canonicalScopes,
  identifyStepUpLimitedClient,
  resolveDefaultAccess,
  resolvePresets,
} from './consent-presets.ts';

/** The scope ceiling every dynamically-registered and CIMD client gets. */
const ALL = [
  'read:email', 'search:email', 'send:email', 'manage:folders', 'delete:email',
  'manage:drafts', 'manage:contacts', 'schedule:email', 'manage:automations',
];

/** The narrower ceiling on the seeded first-party rows (no contacts, no delete). */
const FIRST_PARTY = ['read:email', 'search:email', 'send:email', 'manage:folders', 'manage:drafts'];

const preset = (id: string) => ACCESS_PRESETS.find((p) => p.id === id)!;

// ─── The live case ───────────────────────────────────────────────────────────

test('scope=read:email, what claude.ai actually sends, opens on Read-only', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['read:email'] });
  assert.equal(d.mode, 'readOnly');
  assert.equal(d.recommendedMode, 'readOnly');
  assert.equal(d.basis, 'request');
  assert.deepEqual(d.scopes, ['read:email', 'search:email']);
  // The point of the change: no send, no drafts, no contacts.
  for (const s of ['send:email', 'manage:drafts', 'manage:contacts']) {
    assert.ok(!d.scopes.includes(s), `${s} must not be preselected`);
  }
});

test('read:email plus the vestigial search:email is the same request', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['read:email', 'search:email'] });
  assert.equal(d.mode, 'readOnly');
});

test('search:email alone is NOT Read-only: that token can search and nothing else', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['search:email'] });
  assert.equal(d.mode, 'custom');
  assert.deepEqual(d.scopes, ['search:email']);
});

// ─── Exact matches further up the ladder ─────────────────────────────────────

test('a request equal to Standard opens on Standard', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: [...preset('standard').scopes] });
  assert.equal(d.mode, 'standard');
  assert.deepEqual(d.scopes, [...preset('standard').scopes]);
});

test('a request for all nine scopes opens on Full access', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ALL });
  assert.equal(d.mode, 'full');
  assert.equal(d.recommendedMode, 'full');
  assert.deepEqual(d.scopes, [...preset('full').scopes]);
});

test('scope order does not matter', () => {
  const shuffled = [...preset('standard').scopes].reverse();
  assert.equal(resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: shuffled }).mode, 'standard');
});

// ─── No preset matches ───────────────────────────────────────────────────────

test('read+send matches no preset and lands on Custom with exactly those two', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['read:email', 'send:email'] });
  assert.equal(d.mode, 'custom');
  assert.equal(d.recommendedMode, 'custom');
  assert.deepEqual(d.scopes, ['read:email', 'send:email']);
  // Standard would have covered it and thrown in drafts and contacts. It must not.
  assert.ok(!d.scopes.includes('manage:drafts'));
  assert.ok(!d.scopes.includes('manage:contacts'));
});

test('read+delete does not climb to Full access', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['delete:email', 'read:email'] });
  assert.equal(d.mode, 'custom');
  assert.deepEqual(d.scopes, ['read:email', 'delete:email']);
});

test('Custom is ticked in offered order, not the order the client wrote them', () => {
  const d = resolveDefaultAccess({
    offeredScopes: ALL,
    requestedScopes: ['schedule:email', 'read:email', 'send:email'],
  });
  assert.deepEqual(d.scopes, ['read:email', 'send:email', 'schedule:email']);
});

// ─── Unknown and out-of-ceiling scopes ───────────────────────────────────────

test('an unrecognised scope string is dropped, not honoured and not fatal', () => {
  const d = resolveDefaultAccess({
    offeredScopes: ALL,
    requestedScopes: ['read:email', 'launch:missiles'],
  });
  assert.equal(d.mode, 'readOnly');
  assert.ok(!d.scopes.includes('launch:missiles'));
});

test('a scope outside this client ceiling is dropped', () => {
  const d = resolveDefaultAccess({
    offeredScopes: FIRST_PARTY,
    requestedScopes: ['read:email', 'delete:email'],
  });
  assert.equal(d.mode, 'readOnly');
  assert.ok(!d.scopes.includes('delete:email'));
});

test('a request whose every scope is outside the ceiling falls back to the legacy default', () => {
  // Nothing survives the filter, so there is no request to honour and the
  // pre-2026-09-09 branch runs. Preselecting an empty Custom here would render
  // a screen whose Allow button is dead.
  const d = resolveDefaultAccess({ offeredScopes: FIRST_PARTY, requestedScopes: ['manage:automations'] });
  assert.equal(d.basis, 'no-request');
  assert.ok(d.scopes.length > 0);
});

// ─── The legacy no-scope request ─────────────────────────────────────────────

test('no scope param at all keeps the old Standard default', () => {
  for (const requested of [undefined, null, []] as (string[] | null | undefined)[]) {
    const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: requested });
    assert.equal(d.mode, 'standard', `requested=${JSON.stringify(requested)}`);
    assert.equal(d.recommendedMode, 'standard');
    assert.equal(d.basis, 'no-request');
    assert.deepEqual(d.scopes, [...preset('standard').scopes]);
  }
});

test('no scope param on a client that cannot reach Standard falls to the narrowest available preset', () => {
  // FIRST_PARTY has no manage:contacts, so "standard" is unavailable and the
  // old code picked the first available preset. That is still what happens.
  const d = resolveDefaultAccess({ offeredScopes: FIRST_PARTY, requestedScopes: [] });
  assert.equal(d.mode, 'readOnly');
  assert.equal(d.basis, 'no-request');
});

test('no scope param and no whole preset on offer selects Custom with everything offered', () => {
  const offered = ['read:email', 'send:email'];
  const d = resolveDefaultAccess({ offeredScopes: offered, requestedScopes: [] });
  assert.equal(d.mode, 'custom');
  assert.deepEqual(d.scopes, offered);
});

test('a client offered nothing produces an empty Custom rather than throwing', () => {
  const d = resolveDefaultAccess({ offeredScopes: [], requestedScopes: ['read:email'] });
  assert.equal(d.mode, 'custom');
  assert.deepEqual(d.scopes, []);
});

// ─── Clients that cannot step up (OpenAI review, 2026-09-25) ─────────────────

test('ChatGPT asking for read:email opens on Full access, not Read-only', () => {
  // The rejection: ChatGPT sent scope=read:email, got Read-only, and every send
  // and automation test failed with insufficient_scope because it never steps up.
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['read:email'], clientCannotStepUp: true });
  assert.equal(d.mode, 'full');
  assert.equal(d.recommendedMode, 'full');
  assert.equal(d.basis, 'client-cannot-step-up');
  assert.deepEqual(d.scopes, [...preset('full').scopes]);
  for (const s of ['send:email', 'manage:automations']) assert.ok(d.scopes.includes(s), `${s} must be preselected`);
});

test('a non-stepping client opens on Full whatever it requested, or if it requested nothing', () => {
  for (const requested of [undefined, null, [], ['read:email', 'send:email'], [...preset('standard').scopes], ALL]) {
    const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: requested, clientCannotStepUp: true });
    assert.equal(d.mode, 'full', `requested=${JSON.stringify(requested)}`);
    assert.equal(d.basis, 'client-cannot-step-up');
  }
});

test('clientCannotStepUp=false leaves the request rule exactly as before', () => {
  const d = resolveDefaultAccess({ offeredScopes: ALL, requestedScopes: ['read:email'], clientCannotStepUp: false });
  assert.equal(d.mode, 'readOnly');
  assert.equal(d.basis, 'request');
});

test('a non-stepping client whose ceiling lacks Full gets the widest available preset', () => {
  const d = resolveDefaultAccess({ offeredScopes: FIRST_PARTY, requestedScopes: ['read:email'], clientCannotStepUp: true });
  assert.equal(d.mode, 'readOnly'); // the only whole preset FIRST_PARTY offers
  assert.equal(d.basis, 'client-cannot-step-up');
});

test('a non-stepping client with no whole preset on offer gets Custom with everything offered', () => {
  const offered = ['read:email', 'send:email'];
  const d = resolveDefaultAccess({ offeredScopes: offered, requestedScopes: ['read:email'], clientCannotStepUp: true });
  assert.equal(d.mode, 'custom');
  assert.deepEqual(d.scopes, offered);
});

test('identifies ChatGPT by its connector redirect_uri on an exact OpenAI host', () => {
  for (const redirectUri of [
    'https://chatgpt.com/connector/oauth/AbC_12-x',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://CHATGPT.com/connector/oauth/abc',
    'https://chat.openai.com/connector_platform_oauth_redirect',
  ]) {
    assert.equal(identifyStepUpLimitedClient({ clientId: 'dyn_0123456789abcdef01234567', redirectUri }), 'chatgpt', redirectUri);
  }
});

test('identifies ChatGPT and Codex by OpenAI CIMD client_id URLs', () => {
  const cases: [string, string][] = [
    ['https://chatgpt.com/oauth/client.json', 'chatgpt'],
    ['https://chatgpt.com/oauth/7NsWlQyClcg9/client.json', 'chatgpt'],
    ['https://chatgpt.com/oauth/codex/N4av5zHP4iw0/client.json', 'codex'],
  ];
  for (const [clientId, want] of cases) {
    // Codex's CIMD redirect is loopback; the client_id alone must decide.
    assert.equal(identifyStepUpLimitedClient({ clientId, redirectUri: 'http://127.0.0.1:1455/auth/callback' }), want, clientId);
  }
});

test('host matching is exact: look-alike and suffix hosts are not OpenAI', () => {
  for (const redirectUri of [
    'https://evilchatgpt.com/connector/oauth/abc',
    'https://chatgpt.com.attacker.net/connector/oauth/abc',
    'https://sub.chatgpt.com/connector/oauth/abc',
    'https://chatgpt.com./connector/oauth/abc',
    'https://attacker.net/chatgpt.com/connector/oauth/abc',
    'https://attacker.net/connector/oauth/abc?next=https://chatgpt.com',
    'https://chatgpt.com@attacker.net/connector/oauth/abc',
    'https://user@chatgpt.com/connector/oauth/abc',
    'https://chatgpt.com:8443/connector/oauth/abc',
    'http://chatgpt.com/connector/oauth/abc',
  ]) {
    assert.equal(identifyStepUpLimitedClient({ clientId: 'dyn_x', redirectUri }), null, redirectUri);
  }
  for (const clientId of [
    'https://chatgpt.com.evil.net/oauth/client.json',
    'https://evil.net/oauth/codex/abc/client.json',
    'http://chatgpt.com/oauth/client.json',
  ]) {
    assert.equal(identifyStepUpLimitedClient({ clientId, redirectUri: null }), null, clientId);
  }
});

test('other paths on chatgpt.com are not the connector callback or a CIMD document', () => {
  assert.equal(identifyStepUpLimitedClient({ clientId: 'dyn_x', redirectUri: 'https://chatgpt.com/share/abc' }), null);
  assert.equal(identifyStepUpLimitedClient({ clientId: 'dyn_x', redirectUri: 'https://chatgpt.com/connector/oauth/a/b' }), null);
  assert.equal(identifyStepUpLimitedClient({ clientId: 'https://chatgpt.com/share/x.json', redirectUri: null }), null);
  assert.equal(identifyStepUpLimitedClient({ clientId: 'https://chatgpt.com/oauth/client.json?x=1', redirectUri: null }), null);
});

test('a DCR client merely NAMED Codex or ChatGPT with a loopback redirect is not identified', () => {
  // client_name is never an input; the legacy DCR Codex rows look exactly like this.
  assert.equal(identifyStepUpLimitedClient({ clientId: 'dyn_abc', redirectUri: 'http://127.0.0.1:50299/callback' }), null);
  assert.equal(identifyStepUpLimitedClient({ clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata', redirectUri: 'https://claude.ai/api/mcp/auth_callback' }), null);
  assert.equal(identifyStepUpLimitedClient({ clientId: '', redirectUri: '' }), null);
  assert.equal(identifyStepUpLimitedClient({ clientId: undefined, redirectUri: 'not a url' }), null);
});

// ─── Building blocks ─────────────────────────────────────────────────────────

test('canonicalScopes drops search:email only when read:email is present', () => {
  assert.deepEqual(canonicalScopes(['read:email', 'search:email']), ['read:email']);
  assert.deepEqual(canonicalScopes(['search:email']), ['search:email']);
  assert.deepEqual(canonicalScopes(['read:email', 'read:email']), ['read:email']);
});

test('a preset is available only when every one of its scopes is offered', () => {
  const resolved = resolvePresets(FIRST_PARTY);
  assert.equal(resolved.find((p) => p.id === 'readOnly')!.available, true);
  // standard needs manage:contacts, full needs four more.
  assert.equal(resolved.find((p) => p.id === 'standard')!.available, false);
  assert.equal(resolved.find((p) => p.id === 'full')!.available, false);
});

test('presets are nested and ordered narrowest first', () => {
  for (let i = 1; i < ACCESS_PRESETS.length; i += 1) {
    const narrower = new Set(ACCESS_PRESETS[i - 1].scopes);
    const wider = new Set(ACCESS_PRESETS[i].scopes);
    assert.ok(wider.size > narrower.size);
    for (const s of narrower) assert.ok(wider.has(s), `${s} missing from ${ACCESS_PRESETS[i].id}`);
  }
});

test('every preset scope is a scope the server actually enforces', () => {
  // A preset naming a scope api/oauth/authorize would filter out would produce
  // a default the POST then silently narrows, so the screen would promise more
  // than the token carries.
  for (const p of ACCESS_PRESETS) {
    for (const s of p.scopes) assert.ok(ALL.includes(s), `${s} is not a real scope`);
  }
});
