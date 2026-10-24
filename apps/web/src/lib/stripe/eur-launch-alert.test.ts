// ---------------------------------------------------------------------------
// The `billing.eur_launch` email template in the system-notify edge function
// (supabase/functions/system-notify/eur-launch.ts), fed the alerts the
// dispatcher really builds (eur-launch-run.ts).
//
// Run: node --test --experimental-strip-types src/lib/stripe/eur-launch-alert.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderEurLaunchEmail } from '../../../../../supabase/functions/system-notify/eur-launch.ts';
import { preflightAlert, liveAlert, type PreflightCheck } from './eur-launch-run.ts';

const checks: PreflightCheck[] = [
  { code: 'tax_registrations', ok: false, detail: 'missing active Stripe Tax registration: EU non-Union OSS (oss_non_union)', fix: 'Add it.' },
  { code: 'webhook_events', ok: true, detail: 'an enabled endpoint receives all three SEPA events', fix: '' },
];

test('a failed preflight renders with every failed check and what to do', () => {
  const alert = preflightAlert(checks, '2026-12-07');
  const email = renderEurLaunchEmail({ kind: alert.kind, subject: alert.subject, lines: alert.lines });
  assert.ok(email);
  assert.equal(email.subject, 'EUR launch is waiting: 1 check failed');
  assert.match(email.body, /FAILED tax_registrations: missing active Stripe Tax registration/);
  assert.match(email.body, /What to do: Add it\./);
  assert.match(email.body, /ok webhook_events/);
  assert.match(email.body, /at most once a day/);
});

test('the live alert renders', () => {
  const alert = liveAlert({ checks: checks.map((c) => ({ ...c, ok: true })), changes: { pricesUpdated: 9, productsTagged: 1 }, swap: null });
  const email = renderEurLaunchEmail({ ...alert });
  assert.equal(email?.subject, 'EUR launch live: EUR prices, Stripe Tax and SEPA are on');
  assert.match(email?.body ?? '', /STRIPE_FORCE_USD=true/);
});

test('a payload of the wrong shape renders nothing, and sizes are capped', () => {
  assert.equal(renderEurLaunchEmail({}), null);
  assert.equal(renderEurLaunchEmail({ kind: 'something_else', lines: ['x'] }), null);
  const big = renderEurLaunchEmail({ kind: 'live', subject: 'a\nb', lines: Array.from({ length: 500 }, () => 'y'.repeat(5000)) });
  assert.ok(big);
  assert.equal(big.subject, 'a b');
  assert.ok(big.body.split('\n').length <= 62);
  assert.ok(big.body.length < 60 * 601 + 200);
  assert.equal(renderEurLaunchEmail({ kind: 'swap_failed' })?.subject, 'EUR launch: legacy EU swap failures');
});
