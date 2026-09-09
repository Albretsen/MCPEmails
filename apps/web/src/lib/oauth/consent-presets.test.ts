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
