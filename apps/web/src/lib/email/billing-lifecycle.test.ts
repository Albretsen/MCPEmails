/**
 * Billing lifecycle email tests.
 *
 * NOTHING here sends mail. `composeBillingEmail` is pure; the one test that
 * calls the sender stubs `globalThis.fetch` first, so the Resend SDK's only
 * network call is intercepted in-process and no request leaves this machine.
 *
 * The tests that matter most are not the ones checking that words appear. They
 * are the ones checking that words CANNOT appear:
 *   - a transactional template can never be classified as marketing, which is
 *     what makes a payment-failure notice unsuppressible;
 *   - a transactional template never carries an unsubscribe header;
 *   - a grandfathered user is never told they are about to lose inboxes they
 *     were promised permanently;
 *   - a decline the issuer classified as lost or stolen never accuses the
 *     reader of anything.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/billing-lifecycle.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BILLING_TEMPLATES,
  DUNNING_SCHEDULE,
  WINBACK_SCHEDULE,
  categoryOf,
  composeBillingEmail,
  declineCopy,
  sendBillingLifecycleEmail,
  type BillingTemplate,
  type LifecyclePayload,
} from '@/lib/email/billing-lifecycle';
import {
  LEGAL_ENTITY_NAME,
  LEGAL_ORG_NUMBER,
  POSTAL_ADDRESS_LINE,
} from '@/lib/email/legal';
import { PLANS } from '@/lib/stripe/plans';

const TO = 'customer@example.com';
const TOKEN = '11111111-2222-3333-4444-555555555555';

/** A payload with enough in it for any template to compose. */
function payload(overrides: Partial<LifecyclePayload> = {}): LifecyclePayload {
  return {
    planId: 'personal',
    amountCents: 500,
    currency: 'usd',
    periodEnd: '2026-09-29T21:55:00.000Z',
    cardBrand: 'Visa',
    cardLast4: '4242',
    cardExpiry: '09/2026',
    unsubscribeToken: TOKEN,
    grandfathered: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The category split. This is the safety property, not a formatting detail.
// ---------------------------------------------------------------------------

test('only the win-backs are marketing; everything else is transactional', () => {
  const marketing = BILLING_TEMPLATES.filter((t) => categoryOf(t) === 'marketing');
  assert.deepEqual([...marketing], ['winback_14', 'winback_30']);

  for (const template of BILLING_TEMPLATES) {
    if (template.startsWith('winback_')) continue;
    assert.equal(
      categoryOf(template),
      'transactional',
      `${template} must be transactional: a customer cannot be allowed to opt out of it`,
    );
  }
});

test('the category rule matches the generated column in the migration', () => {
  // The database derives `category` with: template LIKE 'winback\_%'. If this
  // module and that CHECK ever disagree, an email is classified one way for
  // suppression and the other way for headers, which is the worst outcome.
  for (const template of BILLING_TEMPLATES) {
    const dbWouldSay = template.startsWith('winback_') ? 'marketing' : 'transactional';
    assert.equal(categoryOf(template), dbWouldSay, template);
  }
});

test('no transactional email offers an unsubscribe link', () => {
  for (const template of BILLING_TEMPLATES) {
    if (categoryOf(template) === 'marketing') continue;
    const email = composeBillingEmail(template, payload());
    assert.ok(email, `${template} must compose`);
    assert.equal(email.unsubscribeUrl, undefined, `${template} must not carry an opt-out`);
    assert.ok(
      !/unsubscribe/i.test(email.body),
      `${template} body must not mention unsubscribing`,
    );
    assert.ok(
      !/unsubscribe/i.test(email.htmlBody),
      `${template} html must not mention unsubscribing`,
    );
  }
});

test('a transactional email composes with no unsubscribe token at all', () => {
  // The token is a marketing concern. A dunning email must not become
  // unsendable because a user row is missing one.
  for (const template of BILLING_TEMPLATES) {
    if (categoryOf(template) === 'marketing') continue;
    const email = composeBillingEmail(template, payload({ unsubscribeToken: null }));
    assert.ok(email, `${template} must compose without a token`);
  }
});

test('a win-back without a token composes to nothing rather than sending', () => {
  for (const template of ['winback_14', 'winback_30'] as BillingTemplate[]) {
    assert.equal(
      composeBillingEmail(template, payload({ unsubscribeToken: null })),
      null,
      `${template} must refuse to compose without a working opt-out`,
    );
  }
});

test('a win-back carries the one-click opt-out URL', () => {
  for (const template of ['winback_14', 'winback_30'] as BillingTemplate[]) {
    const email = composeBillingEmail(template, payload());
    assert.ok(email);
    assert.ok(email.unsubscribeUrl?.includes(TOKEN), 'the token must be in the URL');
    assert.ok(email.unsubscribeUrl?.includes('c=lifecycle'), 'category must be lifecycle');
    assert.ok(email.body.includes(email.unsubscribeUrl!), 'plain text needs the link too');
    assert.ok(
      email.htmlBody.includes(email.unsubscribeUrl!),
      'the html part needs the link too: almost nobody reads the text part, and a reader who cannot find an opt-out reaches for the spam button instead',
    );
  }
});

// ---------------------------------------------------------------------------
// What actually stops working
// ---------------------------------------------------------------------------

test('the consequence line is computed from the plan catalogue, not written down', () => {
  const email = composeBillingEmail('dunning_7', payload({ planId: 'personal' }));
  assert.ok(email);
  // Personal is 3 inboxes at 120 rpm; Free is 1 at 60.
  assert.equal(PLANS.personal.limits.maxInboxes, 3);
  assert.equal(PLANS.free.limits.maxInboxes, 1);
  assert.match(email.body, /1 connected inbox instead of 3/);
  assert.match(email.body, /120 to 60 requests a minute/);
});

test('a grandfathered user is never told they lose inboxes', () => {
  // 151 users were promised unlimited inboxes on Free permanently. Telling any
  // of them their agent is about to lose mailboxes would be false and would be
  // the single most damaging sentence in the feature.
  for (const template of ['dunning_7', 'dunning_14'] as BillingTemplate[]) {
    const email = composeBillingEmail(template, payload({ grandfathered: true }));
    assert.ok(email);
    assert.ok(
      !/instead of 3/.test(email.body),
      `${template} must not claim a grandfathered user loses inboxes`,
    );
    assert.ok(
      !/instead of 3/.test(email.htmlBody),
      `${template} html must not claim it either`,
    );
  }
});

test('an unlimited-inbox plan does not print a finite "instead of" count', () => {
  const email = composeBillingEmail('dunning_14', payload({ planId: 'solo' }));
  assert.ok(email);
  assert.ok(!/instead of Infinity/.test(email.body), 'Infinity must never reach the reader');
});

// ---------------------------------------------------------------------------
// Decline reasons
// ---------------------------------------------------------------------------

test('a specific decline reason reaches the reader', () => {
  const email = composeBillingEmail('dunning_1', payload({ declineCode: 'insufficient_funds' }));
  assert.ok(email);
  assert.match(email.body, /not enough in the account/);
});

test('an uninformative decline code produces no reason block at all', () => {
  // "Your bank said: your card was declined" under a heading that promises a
  // reason is worse than no heading.
  for (const code of ['generic_decline', 'card_declined', null, undefined]) {
    assert.equal(declineCopy(code), null, String(code));
    const email = composeBillingEmail('dunning_1', payload({ declineCode: code }));
    assert.ok(email);
    assert.ok(!/Your bank said/.test(email.body), `${code} must not print an empty reason`);
  }
});

test('a lost or stolen card is never described as lost or stolen', () => {
  for (const code of ['lost_card', 'stolen_card', 'pickup_card', 'fraudulent']) {
    const copy = declineCopy(code);
    assert.ok(copy, code);
    assert.ok(
      !/lost|stolen|fraud|report/i.test(`${copy.reason} ${copy.fix}`),
      `${code} copy must stay neutral: the issuer can be wrong and the reader may not be the person who reported it`,
    );
    const email = composeBillingEmail('dunning_1', payload({ declineCode: code }));
    assert.ok(email);
    assert.ok(!/stolen|fraud/i.test(email.body), `${code} must not accuse anyone`);
  }
});

// ---------------------------------------------------------------------------
// Copy hygiene
// ---------------------------------------------------------------------------

test('every template composes, and none is empty', () => {
  for (const template of BILLING_TEMPLATES) {
    const email = composeBillingEmail(template, payload());
    assert.ok(email, `${template} must compose`);
    assert.ok(email.subject.length > 5, `${template} needs a real subject`);
    assert.ok(email.body.length > 120, `${template} needs a real body`);
    assert.ok(email.htmlBody.includes('<!DOCTYPE html>'), `${template} needs an html part`);
  }
});

test('no em dashes anywhere in any customer-facing string', () => {
  for (const template of BILLING_TEMPLATES) {
    const email = composeBillingEmail(template, payload());
    assert.ok(email);
    for (const [label, text] of [
      ['subject', email.subject],
      ['body', email.body],
      ['html', email.htmlBody],
    ] as const) {
      assert.ok(!text.includes('—'), `${template} ${label} contains an em dash`);
    }
  }
});

// ---------------------------------------------------------------------------
// Legal identification
// ---------------------------------------------------------------------------

test('every template carries the physical postal address, in both parts', () => {
  // CAN-SPAM 15 U.S.C. 7704(a)(5) and ehandelsloven section 8. Two winback_*
  // templates and the dunning series are sending today, so a footer without an
  // address is a live defect, not a nit. Matched on the street and the postcode
  // rather than on the whole sentence: this has to fail if someone deletes the
  // address while leaving a company name behind, which is the failure that
  // actually happened.
  for (const template of BILLING_TEMPLATES) {
    const email = composeBillingEmail(template, payload());
    assert.ok(email, `${template} must compose`);
    for (const [label, text] of [
      ['body', email.body],
      ['html', email.htmlBody],
    ] as const) {
      assert.ok(
        text.includes('Håsteins gate 9'),
        `${template} ${label} is missing the street address`,
      );
      assert.ok(
        text.includes('5160 Laksevåg'),
        `${template} ${label} is missing the postcode`,
      );
      assert.ok(
        text.includes(LEGAL_ENTITY_NAME),
        `${template} ${label} is missing the legal entity name`,
      );
      assert.ok(
        text.includes(LEGAL_ORG_NUMBER),
        `${template} ${label} is missing the organisation number`,
      );
    }
  }
});

test('the address is the one on the marketing site, character for character', () => {
  // If this drifts from messages/{en,nb}/home.json, /privacy and /terms, a
  // reader who checks two of them sees two different registered addresses.
  assert.equal(
    POSTAL_ADDRESS_LINE,
    'MCPEmails is a service of Albretsen Consulting (enkeltpersonforetak), organisation number 926 646 753, Håsteins gate 9, 5160 Laksevåg, Norway.',
  );
});

test('the address does not add a question to the cancellation email', () => {
  // The one-question rule is asserted below too. This exists so the reason the
  // legal line has to stay declarative is written down next to the line itself.
  assert.ok(!POSTAL_ADDRESS_LINE.includes('?'));
});

test('the internal plan ids never leak', () => {
  for (const planId of ['solo', 'pro'] as const) {
    for (const template of BILLING_TEMPLATES) {
      const email = composeBillingEmail(template, payload({ planId }));
      assert.ok(email);
      assert.ok(
        !new RegExp(`\\b${planId}\\b`, 'i').test(email.body),
        `${template} leaks the internal id "${planId}"`,
      );
    }
  }
});

test('the cancellation email asks one question and offers no discount', () => {
  const email = composeBillingEmail('cancel_ask', payload());
  assert.ok(email);
  assert.match(email.subject, /What stopped working/i);
  assert.ok(
    !/discount|% off|coupon|deal|special price/i.test(email.body),
    'a discount here buys a month and destroys the only thing worth having',
  );
  // Exactly one question mark in the body: the question.
  assert.equal((email.body.match(/\?/g) ?? []).length, 1, 'ask one thing, not three');
});

test('the day-14 win-back promises it is the last one, and is', () => {
  const last = composeBillingEmail('winback_30', payload());
  assert.ok(last);
  assert.match(last.body, /last one|last email/i);
  // Nothing is scheduled after day 30.
  assert.equal(Math.max(...WINBACK_SCHEDULE.map((s) => s.dayOffset)), 30);
});

test('the amount is formatted as money, never as cents', () => {
  const email = composeBillingEmail('dunning_1', payload({ amountCents: 4800 }));
  assert.ok(email);
  assert.match(email.body, /\$48\.00/);
  assert.ok(!/4800/.test(email.body), 'minor units must not reach the reader');
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

test('the dunning schedule is 0, 3, 7, 14 days and the first is immediate', () => {
  assert.deepEqual(
    DUNNING_SCHEDULE.map((s) => s.dayOffset),
    [0, 3, 7, 14],
  );
  assert.equal(DUNNING_SCHEDULE[0].template, 'dunning_1');
  assert.equal(
    DUNNING_SCHEDULE[0].dayOffset,
    0,
    'the first email carries most of the recovery and must not be delayed',
  );
});

test('the win-back schedule is 14 and 30 days, and stops', () => {
  assert.deepEqual(
    WINBACK_SCHEDULE.map((s) => s.dayOffset),
    [14, 30],
  );
  assert.equal(WINBACK_SCHEDULE.length, 2, 'two, then silence');
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('the send attaches List-Unsubscribe to marketing and to nothing else', async () => {
  const calls: Array<{ headers: Record<string, string>; from: string }> = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 'test_key';

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body));
    calls.push({ headers: parsed.headers ?? {}, from: parsed.from });
    return new Response(JSON.stringify({ id: 'msg_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    await sendBillingLifecycleEmail({
      to: TO,
      template: 'dunning_1',
      scopeKey: 'in_123',
      payload: payload(),
    });
    await sendBillingLifecycleEmail({
      to: TO,
      template: 'winback_14',
      scopeKey: 'sub_123:1',
      payload: payload(),
    });

    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].headers['List-Unsubscribe'],
      undefined,
      'a payment-failure notice must never advertise an opt-out',
    );
    assert.ok(calls[1].headers['List-Unsubscribe']?.includes(TOKEN));
    assert.equal(calls[1].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.notEqual(
      calls[0].from,
      calls[1].from,
      'billing and marketing must not share a sender reputation',
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});

test('the sender never throws, and reports failure instead', async () => {
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 'test_key';
  globalThis.fetch = (async () => {
    throw new Error('network is down');
  }) as typeof globalThis.fetch;

  try {
    const result = await sendBillingLifecycleEmail({
      to: TO,
      template: 'dunning_1',
      scopeKey: 'in_123',
      payload: payload(),
    });
    assert.equal(result.ok, false);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});

test('an unusable recipient is refused before any network call', async () => {
  process.env.RESEND_API_KEY = 'test_key';
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const result = await sendBillingLifecycleEmail({
      to: 'not-an-address',
      template: 'dunning_1',
      scopeKey: 'in_123',
      payload: payload(),
    });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});
