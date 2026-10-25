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
import { createHash } from 'node:crypto';

import {
  BILLING_TEMPLATES,
  DUNNING_SCHEDULE,
  USAGE_TEMPLATES,
  WINBACK_SCHEDULE,
  categoryOf,
  composeBillingEmail,
  declineCopy,
  isUsageTemplate,
  lifecycleIdempotencyKey,
  sendBillingLifecycleEmail,
  sendInputForQueueRow,
  type BillingTemplate,
  type LifecyclePayload,
} from '@/lib/email/billing-lifecycle';
import {
  LEGAL_ENTITY_NAME,
  LEGAL_ORG_NUMBER,
  POSTAL_ADDRESS_LINE,
} from '@/lib/email/legal';
import { PLANS } from '@/lib/stripe/plans';
import { verifyFeedbackToken } from '@/lib/billing/feedback-token';

// The signed /billing/feedback links in cancel_ask need the server secret.
process.env.CSRF_SECRET = 'ab'.repeat(32);

const TO = 'customer@example.com';
const TOKEN = '11111111-2222-3333-4444-555555555555';
const WORKSPACE = '0f3c9a2e-5d1b-4c7e-9a8f-1234567890ab';
const RULE = '7b1e2d3c-4f5a-4b6c-8d7e-0987654321fe';
/** As PostgREST serialises a timestamptz: "+00:00", never "Z". */
const PERIOD_START_PG = '2026-09-08T00:00:00+00:00';
const PERIOD_END_PG = '2026-10-01T00:00:00+00:00';

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
    // The usage notices, as the edge function queues them (snake_case jsonb).
    used: 120,
    cap: 150,
    period_start: PERIOD_START_PG,
    period_end: PERIOD_END_PG,
    plan: 'free',
    rule_id: RULE,
    rule_name: 'Archive newsletters',
    ...overrides,
  };
}

/** A workspace-keyed queue row exactly as claim_billing_emails returns it. */
function usageRow(template: BillingTemplate, overrides: Partial<LifecyclePayload> = {}) {
  return {
    id: 42,
    stripe_customer_id: null,
    workspace_id: WORKSPACE,
    period_start: PERIOD_START_PG,
    user_id: '00000000-0000-4000-8000-000000000001',
    recipient: TO,
    template,
    category: 'transactional' as const,
    scope_key: template === 'automation_paused_limit' ? RULE : PERIOD_START_PG,
    payload: payload(overrides),
    attempts: 1,
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

test('the three usage notices are transactional, keyed by workspace, and nothing else is', () => {
  // 20260912200000_free_action_cap_150.sql lists exactly these three in the
  // template CHECK and the category expression, and only rows with these
  // templates carry workspace_id. A fourth name here without a migration would
  // be refused by the CHECK at queue time.
  assert.deepEqual(
    [...USAGE_TEMPLATES],
    ['usage_warning_80', 'usage_limit_reached', 'automation_paused_limit'],
  );
  for (const template of USAGE_TEMPLATES) {
    assert.equal(categoryOf(template), 'transactional', `${template} must not be suppressible`);
    assert.ok(isUsageTemplate(template));
  }
  for (const template of BILLING_TEMPLATES) {
    if ((USAGE_TEMPLATES as ReadonlyArray<string>).includes(template)) continue;
    assert.ok(!isUsageTemplate(template), `${template} is Stripe-keyed`);
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

test('a EUR renewal is quoted in EUR, and a currency decline names the euro', () => {
  const email = composeBillingEmail(
    'dunning_1',
    payload({ amountCents: 900, currency: 'eur', declineCode: 'currency_not_supported' }),
  );
  assert.ok(email);
  assert.match(email.body, /€9\.00/);
  assert.match(email.body, /cannot be charged in euros/);
  assert.ok(!/US dollars|\$\d/.test(email.body));
  assert.match(declineCopy('currency_not_supported')!.reason, /US dollars/);
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
    'MCPEmails is a service of Albretsen AS, organisation number 938 702 373, Håsteins gate 9, 5160 Laksevåg, Norway.',
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
// Free allowance notices
// ---------------------------------------------------------------------------

const UPGRADE_URL = 'https://mcpemails.com/dashboard/settings?upgrade=personal&interval=month&offer=usage_cap';

/**
 * The upgrade URL as it must appear in each part: verbatim in the text part,
 * attribute-escaped inside a real anchor in the HTML part. `&` left raw in an
 * href is tolerated by browsers but is not the same URL in the source, and a
 * link that is only printed as text is not a link.
 */
function assertUpgradeLink(label: 'body' | 'html', text: string): void {
  if (label === 'body') {
    assert.ok(text.includes(UPGRADE_URL), 'body needs the upgrade link with the offer');
    return;
  }
  const escaped = UPGRADE_URL.replace(/&/g, '&amp;');
  assert.ok(text.includes(`href="${escaped}"`), 'html needs the upgrade link as an anchor');
  assert.ok(!text.includes(`href="${UPGRADE_URL}"`), 'html href must be attribute-escaped');
}

test('the 80% warning leads with the numbers and the reset date, in both parts', () => {
  const email = composeBillingEmail('usage_warning_80', payload({ used: 120, cap: 150 }));
  assert.ok(email);
  assert.equal(email.subject, '120 of 150 email actions used this month');
  assert.ok(email.body.startsWith('120 of 150 email actions'), 'numbers first');
  for (const [label, text] of [['body', email.body], ['html', email.htmlBody]] as const) {
    assert.ok(text.includes('120 of 150'), `${label} needs the count`);
    assert.ok(text.includes('2026-10-01'), `${label} needs the reset date as YYYY-MM-DD`);
    assert.ok(text.includes('https://mcpemails.com/dashboard/usage'), `${label} needs the usage link`);
    assertUpgradeLink(label, text);
    assert.ok(/\$9 a month/.test(text), `${label} needs the Personal price`);
    assert.ok(/refused until/.test(text), `${label} must say what stops at 150`);
    assert.ok(/resume automatically/.test(text), `${label} must say automations come back`);
    assert.ok(/dashboard and your data are not affected/.test(text), `${label} must say what does not stop`);
  }
  assert.equal(email.category, 'transactional');
  assert.equal(email.unsubscribeUrl, undefined);
});

test('the limit-reached notice says refused until the date, that retrying will not help, and that automations pause', () => {
  const email = composeBillingEmail('usage_limit_reached', payload({ used: 150, cap: 150 }));
  assert.ok(email);
  assert.equal(email.subject, '150 of 150 email actions used, paused until 2026-10-01');
  for (const [label, text] of [['body', email.body], ['html', email.htmlBody]] as const) {
    assert.ok(text.includes('150 of 150'), `${label} needs the count`);
    assert.ok(/refused until the count resets on 2026-10-01/.test(text), `${label} needs the refusal and the date`);
    assert.ok(/Retrying will not help/.test(text), `${label} must stop the reader retrying`);
    assert.ok(/paused and resume automatically on 2026-10-01/.test(text), `${label} needs the automation line`);
    assert.ok(text.includes('https://mcpemails.com/dashboard/usage'), `${label} needs the usage link`);
    assertUpgradeLink(label, text);
  }
});

test('the paused-automation notice names the rule, the numbers, the resume date and the automations page', () => {
  const email = composeBillingEmail(
    'automation_paused_limit',
    payload({ used: 150, cap: 150, rule_name: 'Archive newsletters' }),
  );
  assert.ok(email);
  assert.equal(email.subject, 'Automation "Archive newsletters" paused until 2026-10-01');
  for (const [label, text] of [['body', email.body], ['html', email.htmlBody]] as const) {
    assert.ok(text.includes('Archive newsletters'), `${label} needs the rule name`);
    assert.ok(text.includes('150 of 150'), `${label} needs the count`);
    assert.ok(/resume automatically on 2026-10-01/.test(text), `${label} needs the resume date`);
    assert.ok(/Nothing was deleted/.test(text), `${label} must say nothing was deleted`);
    assert.ok(text.includes('https://mcpemails.com/dashboard/automations'), `${label} needs the automations link`);
    assertUpgradeLink(label, text);
  }
  assert.ok(
    email.htmlBody.includes('href="https://mcpemails.com/dashboard/automations"'),
    'the automations link must be a real anchor, not printed text',
  );
});

test('a rule name is HTML-escaped and never breaks the subject', () => {
  const email = composeBillingEmail(
    'automation_paused_limit',
    payload({ rule_name: 'Flag <b>urgent</b> & "vip"' }),
  );
  assert.ok(email);
  assert.ok(email.htmlBody.includes('Flag &lt;b&gt;urgent&lt;/b&gt; &amp; &quot;vip&quot;'));
  assert.ok(!email.htmlBody.includes('<b>urgent</b>'), 'raw markup from a rule name must not render');
  assert.equal(email.subject, 'Automation "Flag <b>urgent</b> & "vip"" paused until 2026-10-01');
});

test('the usage notices are declarative: no exclamation marks, no imperative upgrade line', () => {
  for (const template of USAGE_TEMPLATES) {
    const email = composeBillingEmail(template, payload());
    assert.ok(email);
    assert.ok(!email.subject.includes('!'), `${template} subject`);
    assert.ok(!email.body.includes('!'), `${template} body`);
    assert.ok(!/\bUpgrade now\b|\bBuy\b|\bSubscribe\b/i.test(email.body), `${template} must not command`);
    assert.match(email.body, /Personal removes the monthly cap for \$9 a month\./);
    assert.ok(!/\bsolo\b|\bpro\b/i.test(email.body), `${template} leaks an internal plan id`);
  }
});

test('a usage notice without real numbers composes to nothing rather than printing undefined', () => {
  for (const template of USAGE_TEMPLATES) {
    for (const broken of [
      { used: null },
      { cap: null },
      { cap: 0 },
      { period_end: null },
      { period_end: 'not a date' },
    ] as Array<Partial<LifecyclePayload>>) {
      assert.equal(
        composeBillingEmail(template, payload(broken)),
        null,
        `${template} with ${JSON.stringify(broken)} must not compose`,
      );
    }
  }
});

test('the usage notice mentions the paid ceiling of no plan', () => {
  // The Free number is public; the Personal/Pro/Team abuse ceilings are not.
  for (const template of USAGE_TEMPLATES) {
    const email = composeBillingEmail(template, payload());
    assert.ok(email);
    for (const ceiling of ['25000', '25,000', '100000', '100,000', '500000', '500,000', '5000', '5,000']) {
      assert.ok(!email.body.includes(ceiling), `${template} prints a paid ceiling (${ceiling})`);
    }
  }
});

// ---------------------------------------------------------------------------
// The dispatcher's mapping of a workspace-keyed row
// ---------------------------------------------------------------------------

test('a workspace-keyed row maps to the sender with a null Stripe customer and the period', () => {
  const input = sendInputForQueueRow(usageRow('usage_warning_80'));
  assert.equal(input.to, TO);
  assert.equal(input.template, 'usage_warning_80');
  assert.equal(input.workspaceId, WORKSPACE);
  assert.equal(input.periodStart, PERIOD_START_PG);
  assert.equal(input.scopeKey, PERIOD_START_PG);
  assert.equal(input.payload.used, 120);
});

test('the idempotency key for a workspace row is (template, workspace, period_start), normalised', () => {
  // Postgres serialises the timestamptz with "+00:00"; the key must be the same
  // whichever way the value was spelled, or a retry after a lost response
  // would carry a different key and deliver a second copy.
  const expected = `usage_warning_80-${WORKSPACE}-2026-09-08T00:00:00.000Z`;
  assert.equal(lifecycleIdempotencyKey(sendInputForQueueRow(usageRow('usage_warning_80'))), expected);
  assert.equal(
    lifecycleIdempotencyKey({
      template: 'usage_warning_80',
      scopeKey: 'anything',
      workspaceId: WORKSPACE,
      periodStart: '2026-09-08T00:00:00.000Z',
    }),
    expected,
  );
  // The automation notice is keyed on the period, not on the rule in scope_key,
  // matching UNIQUE (workspace_id, template, period_start).
  assert.equal(
    lifecycleIdempotencyKey(sendInputForQueueRow(usageRow('automation_paused_limit'))),
    `automation_paused_limit-${WORKSPACE}-2026-09-08T00:00:00.000Z`,
  );
  assert.ok(lifecycleIdempotencyKey(sendInputForQueueRow(usageRow('usage_limit_reached'))).length <= 256);
});

test('a Stripe-keyed row keeps the original (template, scope_key) key', () => {
  assert.equal(
    lifecycleIdempotencyKey({ template: 'dunning_1', scopeKey: 'in_123', workspaceId: null, periodStart: null }),
    'dunning_1-in_123',
  );
  // A workspace id on a Stripe template must not change its key either.
  assert.equal(
    lifecycleIdempotencyKey({ template: 'dunning_1', scopeKey: 'in_123', workspaceId: WORKSPACE, periodStart: PERIOD_START_PG }),
    'dunning_1-in_123',
  );
});

test('a workspace-keyed row sends on the transactional path: hello@, no List-Unsubscribe, workspace key', async () => {
  const calls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 'test_key';
  delete process.env.BILLING_EMAIL_FROM;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ id: 'msg_ws_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    const result = await sendBillingLifecycleEmail(
      sendInputForQueueRow(usageRow('usage_limit_reached', { used: 150, cap: 150 })),
    );
    assert.deepEqual(result, { ok: true, resendId: 'msg_ws_1' });
    assert.equal(calls.length, 1, 'one attempt, never a retry');
    const [call] = calls;
    assert.equal(call.body.from, 'MCPEmails <hello@mcpemails.com>');
    assert.equal(call.body.reply_to, 'hello@mcpemails.com');
    assert.equal(call.body.to, TO);
    assert.equal(call.body.subject, '150 of 150 email actions used, paused until 2026-10-01');
    assert.ok(String(call.body.text).length > 120, 'the plain-text part must be present');
    assert.ok(String(call.body.html).startsWith('<!DOCTYPE html>'));
    assert.equal(call.body.headers, undefined, 'a service notice carries no List-Unsubscribe header');
    assert.equal(
      call.headers.get('Idempotency-Key'),
      `usage_limit_reached-${WORKSPACE}-2026-09-08T00:00:00.000Z`,
    );
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
});

test('a workspace-keyed row with an unusable payload is refused as not_composable before any network call', async () => {
  const realFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 'test_key';
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const result = await sendBillingLifecycleEmail(
      sendInputForQueueRow(usageRow('usage_warning_80', { used: null, cap: null })),
    );
    assert.deepEqual(result, { ok: false, reason: 'not_composable' });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  }
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

// ---------------------------------------------------------------------------
// The cancellation confirmation (cancel_ask). Order: confirmation, withdrawal,
// optional one-tap reason, and last, after a divider, the neutral pause /
// smaller-plan paragraph (flag-gated, monthly Personal and Pro only).
// ---------------------------------------------------------------------------

const SUB = 'sub_1TestCancel';
const CUS = 'cus_TestCancel';
const PERIOD_END_S = 1_793_404_800; // 2026-10-31T00:00:00Z

function cancelRow(overrides: Partial<LifecyclePayload> = {}, scopeKey = `${SUB}:${PERIOD_END_S}`) {
  return {
    stripe_customer_id: CUS,
    recipient: TO,
    template: 'cancel_ask' as const,
    scope_key: scopeKey,
    payload: payload({ periodEnd: new Date(PERIOD_END_S * 1000).toISOString(), ...overrides }),
  };
}

function cancelEmail(overrides: Partial<LifecyclePayload> = {}) {
  const email = composeBillingEmail('cancel_ask', sendInputForQueueRow(cancelRow(overrides)).payload);
  assert.ok(email);
  return email;
}

function withPauseFlag<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.BILLING_PAUSE_ENABLED;
  if (value === undefined) delete process.env.BILLING_PAUSE_ENABLED;
  else process.env.BILLING_PAUSE_ENABLED = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.BILLING_PAUSE_ENABLED;
    else process.env.BILLING_PAUSE_ENABLED = saved;
  }
}

const OFFER_URL = 'https://mcpemails.com/dashboard/settings?src=cancel_email#billing';
const REASONS = ['too_expensive', 'not_using_enough', 'missing_feature', 'reliability', 'switched_tool', 'temporary_need', 'other'];

test('the cancellation email confirms the cancel, the paid-up date and that nothing is deleted', () => {
  const email = cancelEmail({ planId: 'solo', amountCents: 1500 });
  assert.equal(email.subject, 'Your MCPEmails cancellation is confirmed');
  assert.equal(email.category, 'transactional');
  assert.match(email.body, /^You cancelled your Pro plan\. It stays active until 31 October 2026, which you have already paid for\./);
  assert.ok(email.body.includes('Nothing is deleted either way.'), 'the NOTHING_DELETED line');
  assert.match(email.htmlBody, /Your cancellation is confirmed/);
  assert.match(email.htmlBody, /31 October 2026, which you have already paid for/);
});

test('D3: with a park count above one, the confirmation says the extra inboxes are parked, not deleted', () => {
  const sentence =
    'When your plan ends, one inbox stays active on Free and the others are parked, not deleted. They come back if you subscribe again.';
  const email = cancelEmail({ planId: 'solo', amountCents: 1500, parkInboxCount: 4 });
  const lines = email.body.split('\n');
  assert.equal(lines[1], sentence, 'right after the confirmation, before the withdrawal line');
  assert.ok(email.htmlBody.includes(sentence));
  assert.ok(!/delete your|will lose|warning/i.test(sentence), 'no threat language');
});

test('D3: no parking sentence without the marker, with one inbox, or for a grandfathered owner', () => {
  const marker = /parked, not deleted/;
  assert.ok(!marker.test(cancelEmail({ planId: 'solo', amountCents: 1500 }).body), 'rows queued without the marker');
  assert.ok(!marker.test(cancelEmail({ planId: 'solo', amountCents: 1500, parkInboxCount: 1 }).body), 'one inbox');
  assert.ok(!marker.test(cancelEmail({ planId: 'solo', amountCents: 1500, parkInboxCount: 0 }).body), 'nothing to park');
  assert.ok(
    !marker.test(cancelEmail({ planId: 'solo', amountCents: 1500, parkInboxCount: 3, grandfathered: true }).htmlBody),
    'grandfathered owners keep every inbox',
  );
});

test('without a period end it still says the plan runs to the end of what was paid', () => {
  const email = composeBillingEmail('cancel_ask', payload({ periodEnd: null }));
  assert.ok(email);
  assert.match(email.body, /until the end of the period you have already paid for/);
});

test('the withdrawal line: conditional when the first charge is unknown, plain inside 14 days, gone after', () => {
  const unknown = cancelEmail();
  assert.match(unknown.body, /If your first charge was less than 14 days ago, you can also withdraw from the contract/);
  assert.match(unknown.body, /: https:\/\/mcpemails\.com\/withdrawal$/m);
  assert.match(unknown.htmlBody, /href="[^"]*\/withdrawal"/);

  const recent = cancelEmail({ firstChargeAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  assert.match(recent.body, /Your first charge was less than 14 days ago, so you can also withdraw/);

  const old = cancelEmail({ firstChargeAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
  assert.ok(!/withdraw/i.test(old.body), 'outside the window the line is left out');
  assert.ok(!/\/withdrawal/.test(old.htmlBody));
});

test('the seven reason links each carry a valid token for this cancellation and preselect their reason', () => {
  const email = cancelEmail();
  assert.match(email.body, /If you want to tell us why, one tap is enough:/);
  assert.match(email.body, /Or just reply to this email\./);
  const urls = [...email.body.matchAll(/https:\/\/mcpemails\.com\/billing\/feedback\?t=([^&\s]+)&r=([a-z_]+)/g)];
  assert.deepEqual(urls.map((m) => m[2]), REASONS, 'seven links, in order');
  for (const [, token] of urls) {
    assert.deepEqual(verifyFeedbackToken(decodeURIComponent(token)), {
      subscriptionId: SUB,
      customerId: CUS,
      periodEnd: PERIOD_END_S,
    });
  }
  const hrefs = [...email.htmlBody.matchAll(/href="https:\/\/mcpemails\.com\/billing\/feedback\?t=[^"&]+&amp;r=([a-z_]+)"/g)];
  assert.deepEqual(hrefs.map((m) => m[1]), REASONS, 'seven real anchors in the HTML part');
  for (const label of ['Too expensive', 'Not using it enough', 'Missing a feature', 'Connection or reliability problems', 'Switched to another tool', 'Only needed it for a while', 'Other']) {
    assert.ok(email.body.includes(`${label}: https://`), label);
  }
});

test('a row with no subscription in its scope keeps "just reply" and no links', () => {
  const email = composeBillingEmail('cancel_ask', payload());
  assert.ok(email);
  assert.match(email.body, /If you want to tell us why, just reply to this email\./);
  assert.ok(!/billing\/feedback/.test(email.body));
});

test('the queue row supplies the cancellation identity; values already in the payload win', () => {
  const filled = sendInputForQueueRow(cancelRow()).payload;
  assert.equal(filled.subscriptionId, SUB);
  assert.equal(filled.stripeCustomerId, CUS);
  assert.equal(filled.periodEndSeconds, PERIOD_END_S);
  const bare = sendInputForQueueRow(cancelRow({}, SUB)).payload;
  assert.equal(bare.subscriptionId, SUB);
  assert.equal(bare.periodEndSeconds, null);
  const kept = sendInputForQueueRow(cancelRow({ subscriptionId: 'sub_kept' })).payload;
  assert.equal(kept.subscriptionId, 'sub_kept');
  const other = sendInputForQueueRow({ ...cancelRow(), template: 'winback_14' }).payload;
  assert.equal(other.subscriptionId, undefined, 'only cancel_ask is touched');
});

test('the pause / smaller-plan paragraph shows only with the flag on, on monthly Personal and Pro', () => {
  withPauseFlag(undefined, () => {
    assert.ok(!cancelEmail({ planId: 'solo', amountCents: 1500 }).body.includes(OFFER_URL), 'flag off');
  });
  withPauseFlag('off', () => {
    assert.ok(!cancelEmail({ planId: 'solo', amountCents: 1500 }).body.includes(OFFER_URL), 'flag "off"');
  });
  withPauseFlag('on', () => {
    const pro = cancelEmail({ planId: 'solo', amountCents: 1500 });
    assert.match(pro.body, /you can pause for up to 3 months, or switch to Personal, from your billing page\. Either one replaces this cancellation\./);
    assert.ok(pro.body.includes(OFFER_URL));
    assert.ok(pro.htmlBody.includes(`href="${OFFER_URL}"`));

    const personal = cancelEmail({ planId: 'personal', amountCents: 900 });
    assert.match(personal.body, /you can pause for up to 3 months from your billing page\. That replaces this cancellation\./);
    assert.ok(!/switch to/i.test(personal.body), 'Personal is already the smallest paid plan');

    const legacyPersonal = cancelEmail({ planId: 'personal', amountCents: 500 });
    assert.ok(legacyPersonal.body.includes(OFFER_URL), 'the older $5 Personal price is monthly too');

    const explicit = cancelEmail({ planId: 'solo', amountCents: null, interval: 'month' });
    assert.ok(explicit.body.includes(OFFER_URL), 'interval from the queue wins');
  });
});

test('no pause paragraph for annual plans, Business, Free, unknown intervals or a switch to Free', () => {
  withPauseFlag('on', () => {
    const cases: Array<[string, Partial<LifecyclePayload>]> = [
      ['annual Pro by amount', { planId: 'solo', amountCents: PLANS.solo.yearlyPriceCents }],
      ['annual Personal by interval', { planId: 'personal', interval: 'year', amountCents: 900 }],
      ['Business', { planId: 'pro', amountCents: 3900 }],
      ['no plan', { planId: null }],
      ['unknown amount and interval', { planId: 'solo', amountCents: null }],
      ['billing_switch_free', { planId: 'solo', amountCents: 1500, source: 'billing_switch_free' }],
    ];
    for (const [name, overrides] of cases) {
      const email = cancelEmail(overrides);
      assert.ok(!email.body.includes(OFFER_URL), name);
      assert.ok(!/pause/i.test(email.body), `${name}: no pause wording`);
      assert.ok(!/<hr/.test(email.htmlBody), `${name}: no divider`);
    }
  });
});

test('the pause paragraph is the last thing before the footer, after a divider', () => {
  withPauseFlag('on', () => {
    const email = cancelEmail({ planId: 'solo', amountCents: 1500 });
    const blocks = email.body.split('\n\n');
    const footerAt = blocks.findIndex((b) => b.startsWith('Replies come straight to a person'));
    assert.ok(footerAt > 1);
    assert.match(blocks[footerAt - 1], /^If you only need a break/);
    assert.ok(blocks[footerAt - 1].endsWith(OFFER_URL));
    assert.equal(blocks[footerAt - 2], '----------');
    assert.ok(email.body.indexOf('one tap is enough') < email.body.indexOf('----------'), 'reasons come first');
    assert.ok(email.body.indexOf('/withdrawal') < email.body.indexOf('one tap is enough'), 'withdrawal before reasons');

    const html = email.htmlBody;
    const hr = html.indexOf('<hr');
    assert.ok(hr > html.indexOf('/billing/feedback'), 'divider after the reason links');
    assert.ok(html.indexOf(OFFER_URL) > hr);
    assert.ok(html.indexOf('Replies come straight to a person') > html.lastIndexOf(OFFER_URL));
  });
});

test('the cancellation email: no discount, no em dash, no plan slug, no "30 days", no angle brackets in text', () => {
  withPauseFlag('on', () => {
    for (const planId of ['personal', 'solo', 'pro', null] as const) {
      const email = cancelEmail({ planId, amountCents: planId === 'pro' ? 3900 : 900 });
      for (const part of [email.subject, email.body, email.htmlBody]) {
        assert.ok(!part.includes('—'), 'no em dash');
        assert.ok(!/30 days/i.test(part), 'never "30 days"');
        assert.ok(!/discount|% off|coupon|special price/i.test(part), 'no discount');
        assert.ok(!/are you sure/i.test(part), 'no confirm-shaming');
      }
      // Slugs in prose, outside the reason URLs' `r=` values.
      const prose = email.body.replace(/https:\/\/\S+/g, '');
      assert.ok(!/\bsolo\b/i.test(prose), 'the Pro slug never shows');
      assert.ok(!/<|>/.test(email.body), 'no angle brackets in the plain text');
    }
  });
});

// ---------------------------------------------------------------------------
// A renewal the bank wants approved (SCA / 3DS, decline code
// authentication_required). The card is fine and Stripe's retries cannot
// answer the challenge, so the usual "update the card" copy is wrong twice.
// ---------------------------------------------------------------------------

const HOSTED_INVOICE = 'https://invoice.stripe.com/i/acct_test/test_sca_invoice';
const CONFIRM_TEMPLATES = ['dunning_1', 'dunning_3', 'dunning_7'] as const;

test('an SCA renewal never asks for a new card or promises a retry', () => {
  for (const template of CONFIRM_TEMPLATES) {
    for (const amountCents of [500, null]) {
      for (const planId of ['personal', null] as const) {
        const email = composeBillingEmail(
          template,
          payload({ declineCode: 'authentication_required', hostedInvoiceUrl: HOSTED_INVOICE, amountCents, planId }),
        );
        assert.ok(email, template);
        for (const part of [email.subject, email.body, email.htmlBody]) {
          assert.ok(!/update the card/i.test(part), `${template} must not say "update the card"`);
          assert.ok(!/updating the card/i.test(part), `${template} must not say "updating the card"`);
          assert.ok(!/card update/i.test(part), `${template} must not ask for a card update`);
          assert.ok(!/picks it up/i.test(part), `${template} must not promise the retry fixes it`);
          assert.ok(!/retried automatically/i.test(part), `${template} must not promise a retry`);
        }
        assert.match(email.htmlBody, />\s*Confirm the payment\s*</, `${template} CTA label`);
        assert.ok(email.htmlBody.includes(`href="${HOSTED_INVOICE}"`), `${template} CTA goes to the hosted invoice`);
        assert.ok(
          email.body.split('\n').some((line) => line.trim() === HOSTED_INVOICE),
          `${template} text part carries the hosted invoice on its own line`,
        );
        assert.match(email.body, /approve/i, `${template} says to approve it with the bank`);
        assert.match(email.htmlBody, /approve/i, `${template} html says to approve it with the bank`);
      }
    }
  }
});

test('the SCA first email leads with the bank approval and keeps the plan reassurance', () => {
  const email = composeBillingEmail(
    'dunning_1',
    payload({ declineCode: 'authentication_required', hostedInvoiceUrl: HOSTED_INVOICE, amountCents: 1500 }),
  );
  assert.ok(email);
  assert.equal(email.subject, 'Confirm your MCPEmails payment with your bank');
  assert.ok(
    email.body.startsWith('Your bank asked you to approve the $15.00 renewal for '),
    email.body.split('\n')[0],
  );
  assert.match(email.body, /Nothing is wrong with the card\./);
  assert.match(email.body, /Automatic retries cannot confirm a payment for you/);
  assert.match(email.htmlBody, /Automatic retries cannot confirm a payment for you/);
  assert.match(email.body, /Your plan is still running/);
  assert.match(email.htmlBody, /Your plan is still running/);
  // The generic decline reason block would repeat the lead in other words.
  assert.ok(!/Your bank said/.test(email.body));
});

test('an SCA email without a hosted invoice falls back to the billing page', () => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  for (const template of CONFIRM_TEMPLATES) {
    const email = composeBillingEmail(template, payload({ declineCode: 'authentication_required', hostedInvoiceUrl: null }));
    assert.ok(email);
    assert.match(email.htmlBody, /href="https:\/\/mcpemails\.com\/dashboard\/settings"/, template);
    assert.match(email.body, /https:\/\/mcpemails\.com\/dashboard\/settings/, template);
  }
});

test('the day-14 email is the same for an SCA renewal as for any decline', () => {
  const sca = composeBillingEmail('dunning_14', payload({ declineCode: 'authentication_required', hostedInvoiceUrl: HOSTED_INVOICE }));
  const plain = composeBillingEmail('dunning_14', payload({ declineCode: null, hostedInvoiceUrl: HOSTED_INVOICE }));
  assert.deepEqual(sca, plain);
});

test('the non-SCA dunning copy is byte-for-byte what it was before the SCA branch', () => {
  // A fingerprint of every dunning email over a matrix of decline codes, invoice
  // links, amounts and plans, taken from the composer as it was before the
  // confirm-the-payment variant was added. If you change dunning copy on
  // purpose, recompute it; if you did not, something leaked across the branch.
  delete process.env.NEXT_PUBLIC_APP_URL;
  const out: unknown[] = [];
  for (const template of BILLING_TEMPLATES.filter((t) => t.startsWith('dunning_'))) {
    for (const declineCode of [null, 'insufficient_funds', 'generic_decline', 'expired_card', 'do_not_honor']) {
      for (const hostedInvoiceUrl of [null, 'https://invoice.stripe.com/i/acct_test/inv_test?s=ap']) {
        for (const amountCents of [null, 1500]) {
          for (const planId of [null, 'personal', 'solo'] as const) {
            const p = {
              planId,
              amountCents,
              currency: 'usd',
              declineCode,
              hostedInvoiceUrl,
              periodEnd: '2026-09-29T21:55:00.000Z',
              cardBrand: 'Visa',
              cardLast4: '4242',
              cardExpiry: '09/2026',
              unsubscribeToken: TOKEN,
              grandfathered: false,
            } as LifecyclePayload;
            out.push([template, p, composeBillingEmail(template, p)]);
          }
        }
      }
    }
  }
  assert.equal(out.length, 240);
  assert.equal(
    createHash('sha256').update(JSON.stringify(out)).digest('hex'),
    '1ff6cec493bd715f37316807c860cc1befba91a603cdc2a4e7cd5214768672e9',
  );
});
