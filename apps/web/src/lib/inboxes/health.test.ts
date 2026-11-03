// Run: node --test --experimental-strip-types --import ./scripts/register-ts-alias.mjs src/lib/inboxes/health.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { inboxHealth, lastErrorForDisplay } = await import('./health.ts');
const { OUTLOOK_NO_MAILBOX_REASON } = await import('../email-providers/outlook-oauth.ts');

// The case table the mcp-server's inbox-health.test.ts also runs.
const table = JSON.parse(
  readFileSync(new URL('../../../../../supabase/functions/mcp-server/inbox-health.cases.json', import.meta.url), 'utf8'),
) as {
  noMailboxMessage: string;
  cases: Array<{ name: string; row: { provider: string; status?: string; last_error?: string | null }; expected: string }>;
};

test('the no-mailbox text is the mcp-server one', () => {
  assert.equal(OUTLOOK_NO_MAILBOX_REASON, table.noMailboxMessage);
});

test('inboxHealth matches the shared case table, case by case', () => {
  assert.ok(table.cases.length >= 10);
  for (const c of table.cases) {
    const row = { ...c.row, last_error: c.row.last_error === '@noMailbox' ? table.noMailboxMessage : c.row.last_error };
    assert.equal(inboxHealth(row), c.expected, c.name);
  }
});

test('lastErrorForDisplay drops the Checked suffix and never cuts mid-word', () => {
  const marker = "The mail server refused this mailbox's password. Reconnect this inbox to restore access. (Checked 2026-10-04T20:04:04.730Z)";
  assert.equal(lastErrorForDisplay(marker), "The mail server refused this mailbox's password. Reconnect this inbox to restore access.");
  assert.equal(lastErrorForDisplay(null), null);
  assert.equal(lastErrorForDisplay('  \n '), null);
  assert.equal(lastErrorForDisplay('a\r\nb'), 'a b');
  assert.equal(lastErrorForDisplay('alpha beta gamma delta', 14), 'alpha beta…');
  const long = lastErrorForDisplay(OUTLOOK_NO_MAILBOX_REASON, 120)!;
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith('…'));
  assert.ok(OUTLOOK_NO_MAILBOX_REASON.startsWith(long.slice(0, -1)));
  assert.equal(/\w…$/.test(lastErrorForDisplay('abcdefghij klmnop', 14)!), true);
});
