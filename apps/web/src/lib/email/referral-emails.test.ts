// ---------------------------------------------------------------------------
// The three referral reward emails: the plan copy, plan names (never slugs),
// and the house rules (one-word MCPEmails, no em dash, no "30 days", no
// dollar amounts, straight apostrophes).
//
// Run: npm run test:referrals-server
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';

import { composeReferralEmail, sendReferralEmail } from './referral-emails.ts';

const ALL = [
  composeReferralEmail({ template: 'referral_referrer_credit', to: 'a@example.com', referralId: 'r1', plan: 'solo' }),
  composeReferralEmail({ template: 'referral_referrer_personal', to: 'a@example.com', referralId: 'r1', until: '2026-12-20T10:15:00.000Z' }),
  composeReferralEmail({ template: 'referral_friend_credit', to: 'b@example.com', referralId: 'r1', plan: 'personal' }),
];

test('referrer credit names the plan by its display name', () => {
  const email = ALL[0];
  assert.ok(email);
  assert.equal(email.subject, 'You earned a free month of MCPEmails');
  assert.ok(email.text.includes('We added one month of Pro as credit to your account. It applies to your next invoice.'));
  assert.ok(!/\bsolo\b/.test(email.text));
});

test('Free referrer email gives the end date', () => {
  const email = ALL[1];
  assert.ok(email);
  assert.ok(email.text.includes('We turned on a month of Personal for you, until 20 December 2026.'));
});

test('friend email', () => {
  const email = ALL[2];
  assert.ok(email);
  assert.equal(email.subject, 'Your second month of MCPEmails is on us');
  assert.ok(email.text.includes("Thanks for joining through a friend's invite."));
  assert.ok(email.text.includes('We added one month of Personal as credit; your next invoice uses it.'));
});

test('house rules hold in every body', () => {
  for (const email of ALL) {
    assert.ok(email);
    for (const body of [email.subject, email.text, email.html]) {
      assert.ok(!body.includes('—'), 'no em dash');
      assert.ok(!/30 days/i.test(body), 'no "30 days"');
      assert.ok(!/MCP Emails|Mcpemails/.test(body), 'one word, camel case');
      assert.ok(!/\$\d/.test(body), 'no dollar amounts');
      assert.ok(!/[‘’]/.test(body), 'straight apostrophes');
    }
  }
});

test('nothing honest to say means no email', () => {
  assert.equal(composeReferralEmail({ template: 'referral_referrer_credit', to: 'a@example.com', referralId: 'r1', plan: 'free' }), null);
  assert.equal(composeReferralEmail({ template: 'referral_friend_credit', to: 'a@example.com', referralId: 'r1' }), null);
  assert.equal(composeReferralEmail({ template: 'referral_referrer_personal', to: 'a@example.com', referralId: 'r1', until: null }), null);
});

test('sending without a Resend key reports it and never throws', async () => {
  delete process.env.RESEND_API_KEY;
  assert.deepEqual(
    await sendReferralEmail({ template: 'referral_friend_credit', to: 'b@example.com', referralId: 'r1', plan: 'personal' }),
    { ok: false, reason: 'no_api_key' },
  );
});
