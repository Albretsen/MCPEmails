/**
 * Purchase confirmation email composition tests.
 *
 * NOTHING here sends mail. `buildPurchaseConfirmationEmail` is pure, and the
 * few tests that do call `sendPurchaseConfirmationEmail` stub `globalThis.fetch`
 * first, so the Resend SDK's only network call is intercepted in-process and no
 * request ever leaves this machine.
 *
 * Run:
 *   node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     src/lib/email/purchase-confirmation.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPurchaseConfirmationEmail,
  formatAmount,
  sendPurchaseConfirmationEmail,
} from '@/lib/email/purchase-confirmation';
import { PLANS } from '@/lib/stripe/plans';

test('uses the display name, never the internal plan id', () => {
  const solo = buildPurchaseConfirmationEmail({
    planId: 'solo',
    interval: 'month',
    amountTotalCents: 2900,
    currency: 'usd',
  });
  assert.match(solo.subject, /Your MCPEmails Pro subscription is active/);
  assert.ok(!/\bsolo\b/i.test(solo.body), 'body must not leak the internal id "solo"');
  assert.ok(!/\bsolo\b/i.test(solo.htmlBody), 'html must not leak the internal id "solo"');

  const team = buildPurchaseConfirmationEmail({
    planId: 'pro',
    interval: 'year',
    amountTotalCents: 75600,
    currency: 'usd',
  });
  assert.match(team.subject, /Your MCPEmails Team subscription is active/);
  // "pro" appears legitimately inside "Everything in Pro"; the id must not
  // appear as the plan NAME anywhere.
  assert.ok(!/Your MCPEmails pro/i.test(team.subject));

  const personal = buildPurchaseConfirmationEmail({
    planId: 'personal',
    interval: 'month',
    amountTotalCents: 500,
    currency: 'usd',
  });
  assert.match(personal.subject, /Your MCPEmails Personal subscription is active/);
});

test('states what was bought: plan, amount and interval', () => {
  const monthly = buildPurchaseConfirmationEmail({
    planId: 'personal',
    interval: 'month',
    amountTotalCents: 500,
    currency: 'usd',
  });
  assert.match(monthly.body, /Price: \$5\.00 per month/);
  assert.match(monthly.htmlBody, /\$5\.00 per month/);

  const yearly = buildPurchaseConfirmationEmail({
    planId: 'personal',
    interval: 'year',
    amountTotalCents: 4800,
    currency: 'usd',
  });
  assert.match(yearly.body, /Price: \$48\.00 per year/);
});

test('a $0 charge still produces a confirmation, which is the whole point', () => {
  // Stripe sends no receipt for a $0 invoice. This email is the only thing the
  // customer gets, so it must compose cleanly at zero rather than fall back to
  // the catalogue price and misreport what they were charged.
  const comped = buildPurchaseConfirmationEmail({
    planId: 'solo',
    interval: 'year',
    amountTotalCents: 0,
    currency: 'usd',
  });
  assert.match(comped.body, /Price: \$0\.00 per year/);
});

test('falls back to the catalogue price when Stripe reports no amount', () => {
  const email = buildPurchaseConfirmationEmail({
    planId: 'personal',
    interval: 'year',
    amountTotalCents: null,
    currency: null,
  });
  assert.match(email.body, /Price: \$48\.00 per year/);
});

test('names the concrete inbox entitlement, including the jump from Free', () => {
  const personal = buildPurchaseConfirmationEmail({
    planId: 'personal',
    interval: 'month',
    amountTotalCents: 500,
    currency: 'usd',
  });
  assert.match(personal.body, /3 connected inboxes, up from 1 on Free\./);

  const unlimited = buildPurchaseConfirmationEmail({
    planId: 'solo',
    interval: 'month',
    amountTotalCents: 2900,
    currency: 'usd',
  });
  assert.match(unlimited.body, /Unlimited connected inboxes, up from 1 on Free\./);
});

test('never leaks the silent monthly tool-call ceiling', () => {
  for (const planId of ['personal', 'solo', 'pro'] as const) {
    const email = buildPurchaseConfirmationEmail({
      planId,
      interval: 'month',
      amountTotalCents: 100,
      currency: 'usd',
    });
    const ceiling = PLANS[planId].limits.maxMonthlyToolCalls;
    const combined = `${email.subject}\n${email.body}\n${email.htmlBody}`;
    assert.ok(
      !combined.includes(String(ceiling)),
      `${planId}: the abuse ceiling ${ceiling} must never appear in customer copy`,
    );
    assert.ok(!/tool call/i.test(combined), `${planId}: must not mention tool calls`);
    assert.ok(!/25,000|100,000|500,000/.test(combined), `${planId}: no formatted ceiling either`);
  }
});

test('carries the next action, subscription management and support address', () => {
  const email = buildPurchaseConfirmationEmail({
    planId: 'personal',
    interval: 'month',
    amountTotalCents: 500,
    currency: 'usd',
  });
  assert.match(email.body, /\/dashboard\/inboxes/);
  assert.match(email.htmlBody, /\/dashboard\/inboxes/);
  assert.match(email.body, /\/dashboard\/settings/);
  assert.match(email.htmlBody, /\/dashboard\/settings/);
  assert.match(email.body, /cancel at any time/);
  assert.match(email.body, /hello@mcpemails\.com/);
  assert.match(email.htmlBody, /hello@mcpemails\.com/);
});

test('house style: no em dashes anywhere in the customer copy', () => {
  for (const planId of ['personal', 'solo', 'pro'] as const) {
    for (const interval of ['month', 'year'] as const) {
      const email = buildPurchaseConfirmationEmail({
        planId,
        interval,
        amountTotalCents: 1234,
        currency: 'usd',
      });
      const combined = `${email.subject}\n${email.body}\n${email.htmlBody}`;
      assert.ok(!combined.includes('—'), `${planId}/${interval}: em dash found`);
    }
  }
});

test('formatAmount degrades gracefully rather than throwing', () => {
  assert.equal(formatAmount(500, 'usd'), '$5.00');
  // Intl handles any well-formed 3-letter code, even an unallocated one.
  // (It separates code and amount with a non-breaking space, so match loosely.)
  assert.match(formatAmount(500, 'zzz'), /ZZZ\s5\.00/);
  // A malformed code makes Intl throw; composition must survive it.
  assert.equal(formatAmount(500, 'zz'), '5.00 ZZ');
  assert.equal(formatAmount(500, ''), '$5.00');
});

// ---------------------------------------------------------------------------
// Transport (Resend) - stubbed, never reaches the network
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  payload: Record<string, unknown>;
  headers: Headers;
}

/**
 * Run `fn` with `globalThis.fetch` replaced. The Resend SDK makes exactly one
 * fetch call per send, so the captured list doubles as an assertion that we
 * never retry.
 */
async function withStubbedFetch(
  responder: () => Promise<Response>,
  fn: () => Promise<void>,
): Promise<CapturedRequest[]> {
  const captured: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown; headers?: HeadersInit }) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    } catch {
      /* a non-JSON body is a failure the assertions will surface */
    }
    captured.push({ url: String(input), payload, headers: new Headers(init?.headers) });
    return responder();
  }) as unknown as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SEND_INPUT = {
  to: 'buyer@example.com',
  planId: 'personal',
  interval: 'month',
  amountTotalCents: 500,
  currency: 'usd',
  sessionId: 'cs_test_composition_only',
} as const;

test('sends from the brand address with a support reply-to, exactly once', async () => {
  process.env.RESEND_API_KEY = 're_stub_key_not_a_real_credential';
  delete process.env.PURCHASE_EMAIL_FROM;

  const calls = await withStubbedFetch(
    async () => json(200, { id: 'stubbed-message-id' }),
    () => sendPurchaseConfirmationEmail({ ...SEND_INPUT }),
  );

  assert.equal(calls.length, 1, 'exactly one send attempt: a retry could duplicate the email');
  assert.match(calls[0].url, /resend\.com/);
  assert.equal(calls[0].payload.from, 'MCP Emails <hello@mcpemails.com>');
  assert.equal(calls[0].payload.reply_to, 'hello@mcpemails.com');
  assert.equal(calls[0].payload.to, 'buyer@example.com');
  assert.match(String(calls[0].payload.subject), /Personal subscription is active/);
  // Both parts ride along; neither may leak the internal plan id.
  assert.ok(String(calls[0].payload.text).length > 0);
  assert.ok(String(calls[0].payload.html).startsWith('<!DOCTYPE html>'));
  // Second layer under the Stripe ledger: one key per Checkout session.
  assert.equal(
    calls[0].headers.get('Idempotency-Key'),
    'purchase-confirmation-cs_test_composition_only',
  );
});

test('the sender is overridable, but works with nothing set', async () => {
  process.env.RESEND_API_KEY = 're_stub_key_not_a_real_credential';
  process.env.PURCHASE_EMAIL_FROM = 'MCP Emails <billing@mcpemails.com>';

  const calls = await withStubbedFetch(
    async () => json(200, { id: 'stubbed-message-id' }),
    () => sendPurchaseConfirmationEmail({ ...SEND_INPUT }),
  );
  delete process.env.PURCHASE_EMAIL_FROM;

  assert.equal(calls[0].payload.from, 'MCP Emails <billing@mcpemails.com>');
  // The override must not touch the reply-to: support still reads the replies.
  assert.equal(calls[0].payload.reply_to, 'hello@mcpemails.com');
});

test('a Resend failure is swallowed, never thrown at the webhook', async () => {
  process.env.RESEND_API_KEY = 're_stub_key_not_a_real_credential';

  const calls = await withStubbedFetch(
    async () => json(422, { name: 'validation_error', message: 'stubbed failure' }),
    async () => {
      // The assertion IS that this resolves. A rejection here would mean a
      // bounced email could cost a customer the plan they paid for.
      await sendPurchaseConfirmationEmail({ ...SEND_INPUT });
    },
  );

  assert.equal(calls.length, 1, 'a failed send must not be retried');
});

test('a transport-level throw is swallowed too', async () => {
  process.env.RESEND_API_KEY = 're_stub_key_not_a_real_credential';

  await withStubbedFetch(
    async () => {
      throw new Error('network down');
    },
    async () => {
      await sendPurchaseConfirmationEmail({ ...SEND_INPUT });
    },
  );
});

test('no API key and no usable recipient both skip silently, without sending', async () => {
  const savedKey = process.env.RESEND_API_KEY;

  delete process.env.RESEND_API_KEY;
  let calls = await withStubbedFetch(
    async () => json(200, { id: 'must-not-happen' }),
    () => sendPurchaseConfirmationEmail({ ...SEND_INPUT }),
  );
  assert.equal(calls.length, 0, 'no key means no send at all');

  process.env.RESEND_API_KEY = 're_stub_key_not_a_real_credential';
  calls = await withStubbedFetch(
    async () => json(200, { id: 'must-not-happen' }),
    () => sendPurchaseConfirmationEmail({ ...SEND_INPUT, to: '   ' }),
  );
  assert.equal(calls.length, 0, 'an unusable recipient means no send at all');

  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
});
