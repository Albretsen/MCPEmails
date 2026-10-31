import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardStateOf, type ForwardApprovalRow, type ForwardSendRow } from './run-forward-state.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const approval = (status: string, expires_at: string | null = '2026-11-01T00:00:00Z'): ForwardApprovalRow => ({
  id: 'a', status, expires_at, dispatch_scheduled_send_id: null,
});
const send = (status: string): ForwardSendRow => ({ id: 's', status, approval_id: 'a' });

test('a queued forward reads as what became of it', () => {
  assert.equal(forwardStateOf(approval('pending'), undefined, NOW), 'waiting');
  assert.equal(forwardStateOf(approval('pending', '2026-10-31T11:00:00Z'), undefined, NOW), 'expired', 'past its expiry, not yet swept');
  assert.equal(forwardStateOf(approval('approved'), undefined, NOW), 'sending');
  assert.equal(forwardStateOf(approval('approved'), send('pending'), NOW), 'sending');
  assert.equal(forwardStateOf(approval('approved'), send('sending'), NOW), 'sending');
  assert.equal(forwardStateOf(approval('approved'), send('sent'), NOW), 'sent');
  assert.equal(forwardStateOf(approval('approved'), send('error'), NOW), 'failed');
  assert.equal(forwardStateOf(approval('rejected'), undefined, NOW), 'rejected');
  assert.equal(forwardStateOf(approval('cancelled'), undefined, NOW), 'rejected');
  assert.equal(forwardStateOf(approval('expired'), undefined, NOW), 'expired');
});

test('an approval no longer on record is never called Waiting', () => {
  assert.equal(forwardStateOf(undefined, undefined, NOW), 'closed');
});
