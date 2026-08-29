// ---------------------------------------------------------------------------
// The inbox-cap paywall beacon exists to make one number knowable: of the users
// who were shown a price at the moment they tried to connect a mailbox, how
// many paid. Both halves of that number are destroyed by the same two bugs.
//
// Counting per render instead of per modal-open inflates the denominator with
// paywalls nobody saw twice, and counting a reconnect inflates it with users
// who were never shown a price at all (the modal suppresses the panel in
// reconnect mode). Either one makes the conversion rate read low for reasons
// that have nothing to do with the offer.
//
// Run: node --test src/lib/analytics/inbox-paywall.test.mjs
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInboxPaywallReporter } from './inbox-paywall.mjs';

const shown = { isReconnect: false, atInboxLimit: true, serverLimitReached: false };

test('the panel is reported once, however many times the modal re-renders', () => {
  const shouldReport = createInboxPaywallReporter();
  assert.equal(shouldReport(shown), true);
  assert.equal(shouldReport(shown), false);
  assert.equal(shouldReport(shown), false);
});

test('a second modal-open is a second paywall hit', () => {
  // The guard is per reporter, and the modal builds a fresh one per mount.
  // Re-opening the connect modal after being blocked is real repeated intent.
  assert.equal(createInboxPaywallReporter()(shown), true);
  assert.equal(createInboxPaywallReporter()(shown), true);
});

test('a reconnect is never a paywall, even at the cap', () => {
  // A workspace at its cap still reconnects existing inboxes, and `atInboxLimit`
  // can be true underneath. No price is shown, so nothing is recorded.
  const shouldReport = createInboxPaywallReporter();
  assert.equal(shouldReport({ ...shown, isReconnect: true }), false);
  assert.equal(shouldReport({ ...shown, isReconnect: true, serverLimitReached: true }), false);
});

test('a reconnect does not spend the guard for a later connect', () => {
  // Guard state must only be spent by an event that was actually recorded.
  const shouldReport = createInboxPaywallReporter();
  assert.equal(shouldReport({ ...shown, isReconnect: true }), false);
  assert.equal(shouldReport(shown), true);
});

test('nothing is reported while the panel is hidden', () => {
  const shouldReport = createInboxPaywallReporter();
  assert.equal(
    shouldReport({ isReconnect: false, atInboxLimit: false, serverLimitReached: false }),
    false
  );
});

test('the 402 fallback counts, and only once even if the gate follows it', () => {
  // The stale-prop path: the page loaded under the cap, the server refused.
  const shouldReport = createInboxPaywallReporter();
  assert.equal(shouldReport({ isReconnect: false, atInboxLimit: false, serverLimitReached: true }), true);
  assert.equal(shouldReport({ isReconnect: false, atInboxLimit: true, serverLimitReached: true }), false);
});
