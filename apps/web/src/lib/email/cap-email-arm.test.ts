import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  CAP_EMAIL_HOLDOUT_PERCENT,
  capEmailArm,
  capEmailArmsEnabled,
  isCapEmailControl,
  knownUnitedStates,
} from './cap-email-arm.ts';
import {
  capCheckoutUrl,
  composeBillingEmail,
  type LifecyclePayload,
} from './billing-lifecycle.ts';

/** A workspace id that is NOT in the 20% control group. */
function treatedId(): string {
  for (;;) {
    const id = randomUUID();
    if (!isCapEmailControl(id)) return id;
  }
}
function controlId(): string {
  for (;;) {
    const id = randomUUID();
    if (isCapEmailControl(id)) return id;
  }
}

const base = {
  consented: false,
  unsubscribed: false,
  ownerCountries: [] as string[],
  hasUnsubscribeToken: true,
  enabled: true,
};

test('control group is stable and close to 20%', () => {
  const id = randomUUID();
  assert.equal(isCapEmailControl(id), isCapEmailControl(id));
  let n = 0;
  for (let i = 0; i < 20000; i++) if (isCapEmailControl(randomUUID())) n++;
  const pct = (n / 20000) * 100;
  assert.ok(Math.abs(pct - CAP_EMAIL_HOLDOUT_PERCENT) < 1.5, `control share ${pct}`);
});

test('control wins over every other rule, and the kill switch sends control to all', () => {
  assert.equal(capEmailArm({ ...base, workspaceId: controlId(), consented: true }), 'control');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), consented: true, enabled: false }), 'control');
});

test('consent promotes anywhere, including Europe', () => {
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), consented: true, ownerCountries: ['NO'] }), 'promote');
});

test('without consent only a known US owner is promoted', () => {
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: ['US'] }), 'promote');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: ['US', null] }), 'promote');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: ['DE'] }), 'notice');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: ['CA'] }), 'notice');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: ['US', 'GB'] }), 'notice');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: [] }), 'notice');
});

test('an unsubscribed owner, or one without a working opt-out, gets the notice', () => {
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), consented: true, unsubscribed: true }), 'notice');
  assert.equal(capEmailArm({ ...base, workspaceId: treatedId(), ownerCountries: ['US'], hasUnsubscribeToken: false }), 'notice');
});

test('knownUnitedStates and the env switch', () => {
  assert.equal(knownUnitedStates(['us']), true);
  assert.equal(knownUnitedStates([null, undefined]), false);
  assert.equal(capEmailArmsEnabled({}), true);
  assert.equal(capEmailArmsEnabled({ CAP_EMAIL_ARMS: 'off' }), false);
  assert.equal(capEmailArmsEnabled({ CAP_EMAIL_ARMS: 'on' }), true);
});

// ── Composition ──────────────────────────────────────────────────────────

const usage: LifecyclePayload = {
  used: 150,
  cap: 150,
  period_start: '2026-11-01T00:00:00Z',
  period_end: '2026-12-01T00:00:00Z',
};

for (const template of ['usage_warning_80', 'usage_limit_reached', 'automation_paused_limit'] as const) {
  const payload = { ...usage, used: template === 'usage_warning_80' ? 121 : 150, rule_name: 'Sort newsletters' };

  test(`${template}: control is the original email`, () => {
    const a = composeBillingEmail(template, payload);
    const b = composeBillingEmail(template, { ...payload, capArm: 'control' });
    assert.ok(a && b);
    assert.equal(a.htmlBody, b.htmlBody);
    assert.equal(a.promotional, undefined);
  });

  test(`${template}: promote leads with facts, then a checkout button and an opt-out`, () => {
    const c = composeBillingEmail(template, { ...payload, capArm: 'promote', unsubscribeToken: 'tok-123' });
    assert.ok(c);
    const original = composeBillingEmail(template, payload)!;
    assert.equal(c.subject, original.subject, 'subject stays the account fact');
    assert.equal(c.category, 'transactional');
    assert.equal(c.promotional, true);
    assert.match(c.unsubscribeUrl ?? '', /tok-123/);
    const month = capCheckoutUrl('', 'month', template, 'promote');
    const year = capCheckoutUrl('', 'year', template, 'promote');
    assert.ok(c.htmlBody.includes(month.replace(/&/g, '&amp;')), 'monthly checkout link');
    assert.ok(c.htmlBody.includes(year.replace(/&/g, '&amp;')), 'yearly checkout link');
    assert.match(c.htmlBody, /Upgrade to Personal, \$9 a month/);
    assert.match(c.htmlBody, /Unsubscribe from offers and tips/);
    // Facts before the offer.
    assert.ok(c.htmlBody.indexOf('150</td>') < c.htmlBody.indexOf('Upgrade to Personal'));
    assert.ok(c.body.includes(month) && c.body.includes('tok-123'));
    assert.ok(!/—/.test(c.htmlBody + c.body), 'no em dashes');
    assert.ok(!c.htmlBody.includes('/dashboard/settings?upgrade'), 'no slow settings hop');
  });

  test(`${template}: notice has options and a plain checkout link, no button, no opt-out`, () => {
    const c = composeBillingEmail(template, { ...payload, capArm: 'notice' });
    assert.ok(c);
    assert.equal(c.promotional, undefined);
    assert.equal(c.unsubscribeUrl, undefined);
    assert.match(c.htmlBody, /Your options/);
    assert.match(c.htmlBody, /Switch to Personal/);
    assert.ok(!c.htmlBody.includes('border-radius:8px;">\n                    <a'), 'no CTA button');
    assert.ok(!/Unsubscribe from offers|Pay yearly/.test(c.htmlBody));
    assert.ok(c.body.includes(capCheckoutUrl('', 'month', template, 'notice')));
    assert.ok(!/—/.test(c.htmlBody + c.body), 'no em dashes');
  });

  test(`${template}: promote without a token falls back to the notice`, () => {
    const c = composeBillingEmail(template, { ...payload, capArm: 'promote', unsubscribeToken: null });
    assert.ok(c);
    assert.equal(c.promotional, undefined);
    assert.match(c.htmlBody, /Your options/);
  });
}
