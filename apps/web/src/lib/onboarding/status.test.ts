import test from 'node:test';
import assert from 'node:assert/strict';

import { onboardingResetPatch } from './reset.ts';
import { shapeOnboardingStatus, type OnboardingStatusRows } from './status.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');

function rows(overrides: Partial<OnboardingStatusRows> = {}): OnboardingStatusRows {
  return {
    workspaceId: 'ws-1',
    now: NOW,
    workspace: {
      onboarding_client: 'chatgpt',
      onboarding_reset_at: null,
      onboarding_completed_at: null,
      onboarding_value_activated_at: null,
      analytics_first_tool_used_at: null,
      analytics_first_tool_name: null,
    },
    inboxes: [],
    inboxCount: 0,
    latestKey: null,
    handshakes: [],
    lastFailure: null,
    ...overrides,
  };
}

test('a fresh workspace has nothing yet', () => {
  const s = shapeOnboardingStatus(rows());
  assert.equal(s.serverTime, '2026-10-26T12:00:00.000Z');
  assert.equal(s.client, 'chatgpt');
  assert.deepEqual(s.inboxes, { count: 0, sinceReset: 0, items: [] });
  assert.deepEqual(s.credential, { exists: false, sinceReset: false, latestAt: null, scopes: null });
  assert.deepEqual(s.handshake, { at: null, client: null, clients: [] });
  assert.deepEqual(s.firstCall, { at: null, tool: null });
  assert.equal(s.lastFailure, null);
});

test('every signal is reported, newest handshake first, mapped to a chip id', () => {
  const s = shapeOnboardingStatus(rows({
    workspace: {
      onboarding_client: 'unknown',
      onboarding_reset_at: null,
      onboarding_completed_at: null,
      onboarding_value_activated_at: '2026-10-26T11:50:00Z',
      analytics_first_tool_used_at: '2026-10-26T11:49:00Z',
      analytics_first_tool_name: 'email_read',
    },
    inboxes: [{ id: 'i1', email_address: 'me@example.com', provider: 'imap', status: 'active', created_at: '2026-10-26T11:00:00Z' }],
    inboxCount: 1,
    latestKey: { created_at: '2026-10-26T11:30:00Z' },
    handshakes: [
      { client_name: 'cursor-vscode', first_seen: '2026-10-26T09:00:00Z', last_seen: '2026-10-26T09:00:00Z' },
      { client_name: 'claude-ai', first_seen: '2026-10-26T11:40:00Z', last_seen: '2026-10-26T11:45:00Z' },
    ],
    lastFailure: { created_at: '2026-10-26T11:48:00Z', tool_name: 'email_search', error_code: 'search_timeout' },
  }));
  assert.equal(s.client, null, 'unknown is not a chip id');
  assert.deepEqual(s.inboxes.items, [{ id: 'i1', address: 'me@example.com', provider: 'imap', status: 'active', createdAt: '2026-10-26T11:00:00Z' }]);
  assert.equal(s.inboxes.sinceReset, 1);
  assert.deepEqual(s.credential, { exists: true, sinceReset: true, latestAt: '2026-10-26T11:30:00Z', scopes: null });
  assert.equal(s.handshake.at, '2026-10-26T11:45:00Z');
  assert.equal(s.handshake.client, 'claude');
  assert.deepEqual(s.handshake.clients.map((c) => c.client), ['claude', 'cursor']);
  assert.deepEqual(s.firstCall, { at: '2026-10-26T11:50:00Z', tool: 'email_read' });
  assert.deepEqual(s.anyCall, { at: '2026-10-26T11:49:00Z' });
  assert.deepEqual(s.lastFailure, { at: '2026-10-26T11:48:00Z', tool: 'email_search', code: 'search_timeout' });
});

test('after a reset, older signals are ignored but the inbox is still counted', () => {
  const s = shapeOnboardingStatus(rows({
    workspace: {
      onboarding_client: null,
      onboarding_reset_at: '2026-10-26T11:00:00Z',
      onboarding_completed_at: '2026-10-25T10:00:00Z',
      onboarding_value_activated_at: '2026-10-25T10:00:00Z',
      analytics_first_tool_used_at: '2026-10-25T10:00:00Z',
      analytics_first_tool_name: 'email_read',
    },
    inboxes: [{ id: 'i1', email_address: 'me@example.com', provider: 'imap', status: 'active', created_at: '2026-10-20T11:00:00Z' }],
    inboxCount: 1,
    latestKey: { created_at: '2026-10-20T11:30:00Z' },
    handshakes: [{ client_name: 'claude-ai', first_seen: '2026-10-20T09:00:00Z', last_seen: '2026-10-26T10:59:00Z' }],
    lastFailure: { created_at: '2026-10-26T10:30:00Z', tool_name: 'email_read', error_code: 'x' },
  }));
  assert.equal(s.resetAt, '2026-10-26T11:00:00Z');
  assert.equal(s.completedAt, null);
  assert.deepEqual({ count: s.inboxes.count, sinceReset: s.inboxes.sinceReset }, { count: 1, sinceReset: 0 });
  assert.deepEqual(s.credential, { exists: true, sinceReset: false, latestAt: '2026-10-20T11:30:00Z', scopes: null });
  assert.equal(s.handshake.at, null);
  assert.equal(s.firstCall.at, null);
  assert.equal(s.anyCall.at, null);
  assert.equal(s.lastFailure, null);
});

test('a failure older than 24 hours is not "the last thing that went wrong"', () => {
  const s = shapeOnboardingStatus(rows({ lastFailure: { created_at: '2026-10-25T11:59:00Z', tool_name: 'email_read', error_code: null } }));
  assert.equal(s.lastFailure, null);
});

test('reset rewinds every onboarding and first-use marker and stamps reset_at', () => {
  const patch = onboardingResetPatch('2026-10-26T12:00:00.000Z');
  assert.equal(patch.onboarding_reset_at, '2026-10-26T12:00:00.000Z');
  assert.equal(patch.onboarding_stage, 'started');
  const cleared = Object.entries(patch).filter(([, v]) => v === null).map(([k]) => k).sort();
  for (const column of [
    'onboarding_completed_at', 'onboarding_value_activated_at', 'onboarding_technical_activated_at',
    'onboarding_credential_issued_at', 'onboarding_inbox_connected_at', 'onboarding_client',
    'analytics_first_tool_used_at', 'analytics_first_tool_name', 'analytics_first_inbox_connected_at',
    'analytics_first_credential_created_at',
  ]) assert.ok(cleared.includes(column), column);
  // Nothing outside the markers (and Flow B's two dismissal stamps, WP-H).
  for (const key of Object.keys(patch)) assert.match(key, /^(onboarding_|analytics_first_|plan_summary_dismissed_at$|grace_end_note_seen_at$)/);
  assert.equal(patch.plan_summary_dismissed_at, null);
  assert.equal(patch.grace_end_note_seen_at, null);
});

test('the newest key carries its scopes, so the prompt step can tell a read-only key', () => {
  const s = shapeOnboardingStatus(rows({ latestKey: { created_at: '2026-10-26T11:30:00Z', scopes: ['read:email', 'search:email'] } }));
  assert.deepEqual(s.credential.scopes, ['read:email', 'search:email']);
  const none = shapeOnboardingStatus(rows({ latestKey: { created_at: '2026-10-26T11:30:00Z', scopes: null } }));
  assert.equal(none.credential.scopes, null);
});
