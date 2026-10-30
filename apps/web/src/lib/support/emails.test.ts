// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/support/emails.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

const { buildSupportTicketEmail, buildSupportConfirmationEmail, sendSupportTicketEmail, oneLine, SUPPORT_FROM, SUPPORT_INBOX, supportIdempotencyKey } =
  await import('./emails.ts');

// Distinctive markers: if either appears in the confirmation, visitor text leaked.
const SUBJECT_MARK = 'SUBJMARK-7f3q';
const MESSAGE_MARK = 'MSGMARK-k2v9';

const input = {
  ref: 'MCPE-1001',
  email: 'visitor@example.com',
  category: 'billing' as const,
  subject: `Refund ${SUBJECT_MARK}\r\nBcc: victim@example.com`,
  message: `Please help ${MESSAGE_MARK} <script>alert(1)</script>`,
  source: 'form_signed_in' as const,
  context: {
    workspace_id: '00000000-0000-4000-8000-000000000001',
    plan: 'solo',
    mailboxes: [
      { email: 'ada@example.com', provider: 'imap', service: 'yahoo', service_name: 'Yahoo Mail', host: 'imap.mail.yahoo.com', status: 'error', health: 'reconnect_required' as const, last_error_code: 'AUTHENTICATIONFAILED', last_error_text: 'AUTHENTICATIONFAILED' },
      { email: 'hello@example.com', provider: 'imap', service: 'generic', service_name: 'IMAP', host: 'imap.migadu.example', status: 'active', health: 'reconnect_required' as const, last_error_code: "The mail server refused this mailbox's password. (Checked 2026-10-04T20:04:04.730Z)", last_error_text: "The mail server refused this mailbox's password." },
      { email: 'ok@example.com', provider: 'gmail', service: null, service_name: 'Gmail', host: null, status: 'active', health: 'ok' as const, last_error_code: null, last_error_text: null },
    ],
    from: 'connect-modal',
    provider: 'yahoo',
    code: 'auth_failed',
  },
};

test('support email: subject is "[ref] Category label: subject" on one line', () => {
  const { subject } = buildSupportTicketEmail(input);
  assert.equal(subject, `[MCPE-1001] Billing: Refund ${SUBJECT_MARK} Bcc: victim@example.com`);
  assert.equal(/[\r\n]/.test(subject), false);
});

test('support email: message first, then the context block', () => {
  const { body } = buildSupportTicketEmail(input);
  assert.equal(body.indexOf(MESSAGE_MARK) < body.indexOf('Ref: MCPE-1001'), true);
  for (const line of [
    'Ref: MCPE-1001',
    'Email: visitor@example.com',
    'Category: Billing (billing)',
    'Source: form_signed_in',
    'Workspace: 00000000-0000-4000-8000-000000000001',
    'Plan: Pro (solo)',
    '  - ada@example.com | imap/yahoo | imap.mail.yahoo.com | needs reconnect (status error) | error: AUTHENTICATIONFAILED',
    "  - hello@example.com | imap/generic | imap.migadu.example | needs reconnect (status active) | error: The mail server refused this mailbox's password. (Checked 2026-10-04T20:04:04.730Z)",
    '  - ok@example.com | gmail | active\n',
    'From: connect-modal',
    'Provider: yahoo',
    'Code: auth_failed',
  ]) {
    assert.equal(body.includes(line), true, line);
  }
});

test('support email: the plan shows its display name, never the bare slug', () => {
  const { body } = buildSupportTicketEmail(input);
  assert.equal(/^Plan: solo$/m.test(body), false);
  assert.equal(body.includes('Plan: Pro (solo)'), true);
});

test('support email: HTML escapes the visitor text', () => {
  const { htmlBody } = buildSupportTicketEmail(input);
  assert.equal(htmlBody.includes('<script>'), false);
  assert.equal(htmlBody.includes('&lt;script&gt;'), true);
});

test('support email: an empty context says so', () => {
  const { body } = buildSupportTicketEmail({
    ...input,
    source: 'form_signed_out',
    context: { workspace_id: null, plan: null, mailboxes: [], from: null, provider: null, code: null },
  });
  assert.equal(body.includes('Workspace: -'), true);
  assert.equal(body.includes('(none)'), true);
});

test('confirmation: gives the ref and NEVER the subject or message', () => {
  const c = buildSupportConfirmationEmail({ ref: 'MCPE-1001' });
  const all = `${c.subject}\n${c.body}\n${c.htmlBody}`;
  assert.equal(all.includes('MCPE-1001'), true);
  assert.equal(all.includes(SUBJECT_MARK), false);
  assert.equal(all.includes(MESSAGE_MARK), false);
  assert.equal(all.includes('Refund'), false);
  assert.equal(all.includes('We reply by email within one business day.'), true);
  assert.equal(all.toLowerCase().includes('a person will'), false);
});

test('oneLine strips CR/LF and controls', () => {
  assert.equal(oneLine('a\r\nb\tc\u0000d'), 'a b c d');
});

test('sends: support email goes to support@ with Reply-To the customer; confirmation the reverse', async (t) => {
  const sent: Array<{ payload: Record<string, unknown>; headers: Headers }> = [];
  // Exercise send() without the network by stubbing the global fetch Resend uses.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit = {}) => {
    sent.push({ payload: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  process.env.RESEND_API_KEY = 're_test_dummy';
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  const { sendSupportConfirmationEmail } = await import('./emails.ts');
  assert.equal(await sendSupportTicketEmail(input), true);
  assert.equal(await sendSupportConfirmationEmail({ ref: 'MCPE-1001', email: 'visitor@example.com' }), true);

  assert.equal(sent.length, 2);
  const [ticket, confirmation] = sent.map((s) => s.payload);
  assert.equal(ticket.from, SUPPORT_FROM);
  assert.deepEqual([ticket.to].flat(), [SUPPORT_INBOX]);
  assert.deepEqual([ticket.reply_to].flat(), ['visitor@example.com']);
  assert.equal(confirmation.from, SUPPORT_FROM);
  assert.deepEqual([confirmation.to].flat(), ['visitor@example.com']);
  assert.deepEqual([confirmation.reply_to].flat(), [SUPPORT_INBOX]);
  assert.equal(JSON.stringify(confirmation).includes(MESSAGE_MARK), false);
  const keys = sent.map((s) => s.headers.get('idempotency-key'));
  assert.deepEqual(keys, ['support-production-ticket-MCPE-1001', 'support-production-confirmation-MCPE-1001']);
});

test('sends never throw: no key, or a network failure, is false', async (t) => {
  delete process.env.RESEND_API_KEY;
  assert.equal(await sendSupportTicketEmail(input), false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  process.env.RESEND_API_KEY = 're_test_dummy';
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });
  assert.equal(await sendSupportTicketEmail(input), false);
});

test('the Resend idempotency key differs between staging and production for the same ref', () => {
  // Both environments share one Resend account and number refs from MCPE-1001.
  const saved = process.env.APP_ENV;
  try {
    process.env.APP_ENV = 'staging';
    const staging = supportIdempotencyKey('support', 'ticket', 'MCPE-1001');
    delete process.env.APP_ENV;
    const production = supportIdempotencyKey('support', 'ticket', 'MCPE-1001');
    assert.notEqual(staging, production);
    assert.equal(production, 'support-production-ticket-MCPE-1001');
    assert.equal(supportIdempotencyKey('support', 'ticket', 'MCPE-1001'), production, 'same env and ref: same key, so a retry still dedupes');
  } finally {
    if (saved === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = saved;
  }
});
