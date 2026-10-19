import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSsoSignIn, type SsoConnectionForJoin, type SsoJoinDeps } from './join.ts';
import type { SsoRoute } from './sign-in.ts';
import type { SsoAuditEntry } from './audit.ts';
import type { AddWorkspaceMemberArgs, AddWorkspaceMemberResult } from './workspace-member.ts';

// Only reserved example domains.

const PROVIDER = '550ed000-0000-0000-0000-0000000000a1';
const OTHER_PROVIDER = '550ed000-0000-0000-0000-0000000000b2';
const WORKSPACE = 'aaaaaaaa-0000-0000-0000-000000000001';
const NOW = Date.parse('2026-10-19T12:00:00Z');
const META = { ipAddress: '203.0.113.7', userAgent: 'test-agent' };

const ACTIVE: SsoConnectionForJoin = {
  id: 'conn-1',
  workspace_id: WORKSPACE,
  status: 'active',
  default_role: 'viewer',
};

function ssoUser(createdAt = new Date(NOW - 1000).toISOString()) {
  return {
    id: 'user-1',
    email: 'pat@company-sso.example',
    created_at: createdAt,
    app_metadata: { provider: `sso:${PROVIDER}` },
  };
}

function harness(opts: {
  connection?: SsoConnectionForJoin | null;
  route?: SsoRoute;
  added?: AddWorkspaceMemberResult;
  lookupThrows?: boolean;
} = {}) {
  const added: AddWorkspaceMemberArgs[] = [];
  const audits: SsoAuditEntry[] = [];
  const deps: SsoJoinDeps = {
    routeForEmail: async () => {
      if (opts.lookupThrows) throw new Error('connection reset');
      return opts.route ?? { sso: true, domain: 'company-sso.example', providerId: PROVIDER };
    },
    findConnection: async () => (opts.connection === undefined ? ACTIVE : opts.connection),
    addMember: async (args) => {
      added.push(args);
      return opts.added ?? { ok: true };
    },
    audit: async (entry) => {
      audits.push(entry);
    },
    now: () => NOW,
  };
  return { deps, added, audits };
}

test('happy path: a new SSO user joins the workspace with the default role, audited', async () => {
  const { deps, added, audits } = harness();
  const result = await completeSsoSignIn(deps, ssoUser(), META);
  assert.deepEqual(result, { ok: true, workspaceId: WORKSPACE, joined: true });
  assert.deepEqual(added, [{ workspaceId: WORKSPACE, userId: 'user-1', role: 'viewer', source: 'sso' }]);
  assert.deepEqual(
    audits.map((a) => [a.event, a.status, a.errorCode]),
    [['sso.jit_join', 'success', null], ['sso.sign_in', 'success', null]],
  );
  assert.equal(audits[0].workspaceId, WORKSPACE);
  assert.equal(audits[0].ipAddress, '203.0.113.7');
  assert.equal(audits[0].userAgent, 'test-agent');
});

test('a returning SSO user is re-added (idempotent) and logs only a sign-in', async () => {
  const { deps, added, audits } = harness();
  const result = await completeSsoSignIn(deps, ssoUser('2026-09-01T00:00:00Z'), META);
  assert.deepEqual(result, { ok: true, workspaceId: WORKSPACE, joined: false });
  assert.equal(added.length, 1);
  assert.deepEqual(audits.map((a) => a.event), ['sso.sign_in']);
});

test('unknown provider: refused, nothing joined, nothing audited', async () => {
  const { deps, added, audits } = harness({ connection: null });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_not_configured' });
  assert.equal(added.length, 0);
  assert.equal(audits.length, 0);
});

test('unverified domain: refused and audited as an error', async () => {
  // sso_provider_for_domain returns NULL for an unverified domain.
  const { deps, added, audits } = harness({ route: { sso: false, reason: 'not_configured' } });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_not_configured' });
  assert.equal(added.length, 0);
  assert.deepEqual(audits.map((a) => [a.event, a.status, a.errorCode]), [['sso.sign_in', 'error', 'domain_not_verified']]);
});

test('disabled connection: refused and audited, even if the domain lookup still answered', async () => {
  const { deps, added, audits } = harness({ connection: { ...ACTIVE, status: 'disabled' } });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_not_configured' });
  assert.equal(added.length, 0);
  assert.deepEqual(audits.map((a) => a.errorCode), ['connection_disabled']);
});

test('an IdP asserting an address on a domain another connection owns is refused', async () => {
  const { deps, added, audits } = harness({
    route: { sso: true, domain: 'company-sso.example', providerId: OTHER_PROVIDER },
  });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_not_configured' });
  assert.equal(added.length, 0);
  assert.deepEqual(audits.map((a) => a.errorCode), ['domain_other_connection']);
});

test('add_workspace_member missing (team-tier contract not shipped): refused, audited', async () => {
  const { deps, audits } = harness({
    added: { ok: false, reason: 'contract_missing', message: 'Could not find the function' },
  });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_join_failed' });
  assert.deepEqual(audits.map((a) => [a.event, a.errorCode]), [['sso.jit_join', 'contract_missing']]);
});

test('add_workspace_member refusing (seat cap): refused, audited', async () => {
  const { deps, audits } = harness({ added: { ok: false, reason: 'refused', message: 'seat limit reached' } });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_join_failed' });
  assert.deepEqual(audits.map((a) => a.errorCode), ['refused']);
});

test('a failed lookup refuses instead of letting the user through', async () => {
  const { deps, added } = harness({ lookupThrows: true });
  assert.deepEqual(await completeSsoSignIn(deps, ssoUser(), META), { ok: false, reason: 'sso_join_failed' });
  assert.equal(added.length, 0);
});

test('a non-SSO user is never joined', async () => {
  const { deps, added } = harness();
  const user = { ...ssoUser(), app_metadata: { provider: 'email' } };
  assert.deepEqual(await completeSsoSignIn(deps, user, META), { ok: false, reason: 'sso_not_configured' });
  assert.equal(added.length, 0);
});
