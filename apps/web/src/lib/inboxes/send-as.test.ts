// ---------------------------------------------------------------------------
// Send As for IMAP inboxes: verification, limits and refusals.
//
// The rules are in send-as.ts; this runs them against an in-memory store, a
// recording mailer and a counting rate limiter, so every branch is exercised
// without a database. Run: npm run test:send-as
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addAlias,
  codeMatches,
  hashCode,
  listAliases,
  normalizeAliasAddress,
  normalizeCode,
  removeAlias,
  resendCode,
  SEND_AS_CODE_TTL_MS,
  SEND_AS_MAX_ATTEMPTS,
  SEND_AS_MAX_PER_INBOX,
  SEND_AS_RESEND_COOLDOWN_MS,
  verifyAlias,
  type AliasRow,
  type SendAsDeps,
  type SendAsInbox,
} from './send-as.ts';

const INBOX: SendAsInbox = {
  id: 'inbox-1',
  workspace_id: 'ws-1',
  provider: 'imap',
  email_address: 'primary@icloud.example',
  smtp_host: 'smtp.mail.me.com',
};
const USER = 'user-1';

interface World {
  rows: AliasRow[];
  connected: string[];
  mails: Array<{ to: string; inboxAddress: string; code: string }>;
  buckets: Map<string, number>;
  mailFails: boolean;
  nowMs: number;
}

function world(overrides: Partial<World> = {}): { w: World; deps: SendAsDeps } {
  const w: World = {
    rows: [],
    connected: [],
    mails: [],
    buckets: new Map(),
    mailFails: false,
    nowMs: Date.parse('2026-10-18T12:00:00Z'),
    ...overrides,
  };
  let seq = 0;
  const mine = (inbox: SendAsInbox) => (r: AliasRow) => r.inbox_id === inbox.id && r.workspace_id === inbox.workspace_id;
  const deps: SendAsDeps = {
    now: () => w.nowMs,
    rateLimit: async (key, max) => {
      const n = (w.buckets.get(key) ?? 0) + 1;
      w.buckets.set(key, n);
      return n > max;
    },
    mailer: {
      sendCode: async (params) => {
        if (w.mailFails) throw new Error('resend down');
        w.mails.push(params);
      },
    },
    store: {
      list: async (inbox) => w.rows.filter(mine(inbox)).map((r) => ({ ...r })),
      get: async (inbox, id) => {
        const r = w.rows.find((x) => x.id === id && mine(inbox)(x));
        return r ? { ...r } : null;
      },
      isConnectedInbox: async (_ws, address) => w.connected.includes(address),
      insert: async (inbox, row) => {
        const created: AliasRow = {
          id: `alias-${++seq}`,
          inbox_id: inbox.id,
          workspace_id: inbox.workspace_id,
          email_address: row.email_address,
          display_name: row.display_name,
          verified_at: null,
          code_hash: null,
          code_expires_at: null,
          code_attempts: 0,
          code_sent_at: null,
          created_at: new Date(w.nowMs).toISOString(),
        };
        w.rows.push(created);
        return { ...created };
      },
      update: async (inbox, id, patch) => {
        const r = w.rows.find((x) => x.id === id && mine(inbox)(x));
        if (r) Object.assign(r, patch);
      },
      remove: async (inbox, id) => {
        const before = w.rows.length;
        w.rows = w.rows.filter((x) => !(x.id === id && mine(inbox)(x)));
        return w.rows.length < before;
      },
    },
  };
  return { w, deps };
}

async function addAndGetCode(deps: SendAsDeps, w: World, address = 'alias@icloud.example') {
  const res = await addAlias(deps, INBOX, USER, { email_address: address });
  assert.ok(res.ok, `add failed: ${res.ok ? '' : res.error}`);
  return { alias: res.value, code: w.mails.at(-1)!.code };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

test('addresses are normalised and anything that could break From is refused', () => {
  assert.equal(normalizeAliasAddress('  CrackerJack@iCloud.com '), 'crackerjack@icloud.com');
  for (const bad of [
    'no-at-sign',
    'a@b',
    'two@@x.com',
    'Name <a@b.com>',
    'a@b.com\r\nBcc: v@x.com',
    'a b@c.com',
    'a,b@c.com',
    '"q"@c.com',
    `${'x'.repeat(250)}@c.com`,
    42,
    null,
  ]) {
    assert.equal(normalizeAliasAddress(bad), null, String(bad));
  }
});

test('a code is bound to its row and compared in constant time', () => {
  const h = hashCode('alias-1', '123456');
  assert.equal(codeMatches(h, 'alias-1', '123456'), true);
  assert.equal(codeMatches(h, 'alias-1', '123457'), false);
  assert.equal(codeMatches(h, 'alias-2', '123456'), false, 'a code for one alias never verifies another');
  assert.equal(normalizeCode(' 123 456 '), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode('12345'), null);
  assert.equal(normalizeCode('abcdef'), null);
});

// ── Add + verify ────────────────────────────────────────────────────────────

test('add mails a 6-digit code to the alias, stores only its hash, and is not usable yet', async () => {
  const { w, deps } = world();
  const { alias, code } = await addAndGetCode(deps, w);
  assert.equal(w.mails.length, 1);
  assert.equal(w.mails[0].to, 'alias@icloud.example', 'the code goes TO the alias, not to the requester');
  assert.equal(w.mails[0].inboxAddress, 'primary@icloud.example');
  assert.match(code, /^\d{6}$/);
  assert.equal(alias.verified, false);
  assert.equal(alias.code_pending, true);
  assert.notEqual(w.rows[0].code_hash, code, 'the code is never stored in clear');
  assert.equal(w.rows[0].code_hash, hashCode(w.rows[0].id, code));
  assert.equal(w.rows[0].created_at.length > 0, true);
  assert.ok(!('code_hash' in alias), 'the public shape never carries the hash');
});

test('the right code verifies and clears the pending code', async () => {
  const { w, deps } = world();
  const { alias, code } = await addAndGetCode(deps, w);
  const res = await verifyAlias(deps, INBOX, alias.id, code);
  assert.ok(res.ok);
  assert.equal(res.value.verified, true);
  assert.equal(w.rows[0].code_hash, null);
  assert.ok(w.rows[0].verified_at);
  const listed = await listAliases(deps, INBOX);
  assert.deepEqual(listed.map((a) => [a.email_address, a.verified]), [['alias@icloud.example', true]]);
});

test('a wrong code counts an attempt and the fifth wrong one burns the code', async () => {
  const { w, deps } = world();
  const { alias, code } = await addAndGetCode(deps, w);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 1; i < SEND_AS_MAX_ATTEMPTS; i++) {
    const res = await verifyAlias(deps, INBOX, alias.id, wrong);
    assert.equal(res.ok ? 'ok' : res.error, 'wrong_code', `attempt ${i}`);
  }
  const last = await verifyAlias(deps, INBOX, alias.id, wrong);
  assert.equal(last.ok ? 'ok' : last.error, 'too_many_attempts');
  // Even the right code no longer works: guessing is capped per code.
  const after = await verifyAlias(deps, INBOX, alias.id, code);
  assert.equal(after.ok ? 'ok' : after.error, 'too_many_attempts');
  assert.equal(w.rows[0].verified_at, null);
});

test('an expired code is refused even when it is right', async () => {
  const { w, deps } = world();
  const { alias, code } = await addAndGetCode(deps, w);
  w.nowMs += SEND_AS_CODE_TTL_MS + 1;
  const res = await verifyAlias(deps, INBOX, alias.id, code);
  assert.equal(res.ok ? 'ok' : res.error, 'code_expired');
  assert.equal(w.rows[0].verified_at, null);
});

test('a code cannot verify an alias of another inbox', async () => {
  const { w, deps } = world();
  const { alias, code } = await addAndGetCode(deps, w);
  const other: SendAsInbox = { ...INBOX, id: 'inbox-2' };
  const res = await verifyAlias(deps, other, alias.id, code);
  assert.equal(res.ok ? 'ok' : res.error, 'not_found');
});

// ── Refusals ────────────────────────────────────────────────────────────────

test('Send As is IMAP only and needs SMTP', async () => {
  const { deps } = world();
  for (const provider of ['gmail', 'outlook']) {
    const res = await addAlias(deps, { ...INBOX, provider }, USER, { email_address: 'a@b.example' });
    assert.equal(res.ok ? 'ok' : res.error, 'unsupported_provider', provider);
  }
  const receiveOnly = await addAlias(deps, { ...INBOX, smtp_host: null }, USER, { email_address: 'a@b.example' });
  assert.equal(receiveOnly.ok ? 'ok' : receiveOnly.error, 'no_smtp');
});

test("the inbox's own address and an address connected in this workspace are refused", async () => {
  const { w, deps } = world({ connected: ['other@icloud.example'] });
  const own = await addAlias(deps, INBOX, USER, { email_address: 'PRIMARY@icloud.example' });
  assert.equal(own.ok ? 'ok' : own.error, 'own_address');
  const connected = await addAlias(deps, INBOX, USER, { email_address: 'other@icloud.example' });
  assert.equal(connected.ok ? 'ok' : connected.error, 'connected_inbox');
  assert.equal(w.mails.length, 0, 'no mail for a refused address');
});

test('a header-breaking display name is refused; a clean one is stored', async () => {
  const { w, deps } = world();
  const bad = await addAlias(deps, INBOX, USER, { email_address: 'a@b.example', display_name: 'x'.repeat(101) });
  assert.equal(bad.ok ? 'ok' : bad.error, 'invalid_display_name');
  const good = await addAlias(deps, INBOX, USER, { email_address: 'a@b.example', display_name: '  Pool\r\nCo  ' });
  assert.ok(good.ok);
  assert.equal(w.rows[0].display_name, 'PoolCo');
});

test('an inbox holds at most the cap of aliases', async () => {
  const { deps } = world({
    // Generous buckets: this test is about the per-inbox cap.
  });
  deps.rateLimit = async () => false;
  for (let i = 0; i < SEND_AS_MAX_PER_INBOX; i++) {
    const res = await addAlias(deps, INBOX, USER, { email_address: `a${i}@b.example` });
    assert.ok(res.ok, `alias ${i}`);
  }
  const over = await addAlias(deps, INBOX, USER, { email_address: 'one-more@b.example' });
  assert.equal(over.ok ? 'ok' : over.error, 'too_many_aliases');
});

test('a verified address cannot be re-added', async () => {
  const { w, deps } = world();
  const { alias, code } = await addAndGetCode(deps, w);
  await verifyAlias(deps, INBOX, alias.id, code);
  const again = await addAlias(deps, INBOX, USER, { email_address: 'alias@icloud.example' });
  assert.equal(again.ok ? 'ok' : again.error, 'already_verified');
});

// ── Limits ──────────────────────────────────────────────────────────────────

test('re-adding an unverified address resends to the same row, after the cooldown', async () => {
  const { w, deps } = world();
  await addAndGetCode(deps, w);
  const soon = await addAlias(deps, INBOX, USER, { email_address: 'alias@icloud.example' });
  assert.equal(soon.ok ? 'ok' : soon.error, 'cooldown');
  w.nowMs += SEND_AS_RESEND_COOLDOWN_MS;
  const later = await addAlias(deps, INBOX, USER, { email_address: 'alias@icloud.example' });
  assert.ok(later.ok);
  assert.equal(w.rows.length, 1, 'no second row');
  assert.equal(w.mails.length, 2);
});

test('the old code stops working once a new one is sent', async () => {
  const { w, deps } = world();
  const { alias, code: first } = await addAndGetCode(deps, w);
  w.nowMs += SEND_AS_RESEND_COOLDOWN_MS;
  const res = await resendCode(deps, INBOX, alias.id);
  assert.ok(res.ok);
  const second = w.mails.at(-1)!.code;
  if (first !== second) {
    const stale = await verifyAlias(deps, INBOX, alias.id, first);
    assert.equal(stale.ok ? 'ok' : stale.error, 'wrong_code');
  }
  const fresh = await verifyAlias(deps, INBOX, alias.id, second);
  assert.ok(fresh.ok);
});

test('mail to one address is capped per hour, and removing the alias does not reset it', async () => {
  const { w, deps } = world();
  let sent = 0;
  let refused = false;
  for (let i = 0; i < 6 && !refused; i++) {
    const res = await addAlias(deps, INBOX, USER, { email_address: 'victim@elsewhere.example' });
    if (res.ok) {
      sent++;
      // The attacker's move: remove and re-add to get a fresh row.
      await removeAlias(deps, INBOX, res.value.id);
      w.nowMs += SEND_AS_RESEND_COOLDOWN_MS;
    } else {
      assert.equal(res.error, 'rate_limited');
      refused = true;
    }
  }
  assert.equal(sent, 3, 'three mails per destination per hour');
  assert.equal(refused, true);
  assert.equal(w.mails.length, 3);
});

test('a failed verification mail leaves no live code and no cooldown', async () => {
  const { w, deps } = world({ mailFails: true });
  const res = await addAlias(deps, INBOX, USER, { email_address: 'alias@icloud.example' });
  assert.equal(res.ok ? 'ok' : res.error, 'mail_failed');
  assert.equal(w.rows[0].code_hash, null);
  assert.equal(w.rows[0].code_sent_at, null);
  w.mailFails = false;
  const retry = await resendCode(deps, INBOX, w.rows[0].id);
  assert.ok(retry.ok, 'the user can retry at once');
});

test('remove deletes only within the inbox', async () => {
  const { w, deps } = world();
  const { alias } = await addAndGetCode(deps, w);
  const elsewhere = await removeAlias(deps, { ...INBOX, workspace_id: 'ws-2' }, alias.id);
  assert.equal(elsewhere.ok ? 'ok' : elsewhere.error, 'not_found');
  assert.equal(w.rows.length, 1);
  const res = await removeAlias(deps, INBOX, alias.id);
  assert.ok(res.ok);
  assert.equal(w.rows.length, 0);
});

// ── The verification mail ───────────────────────────────────────────────────

test('the verification mail carries the code and the two addresses, escaped, and nothing else typed', async () => {
  const { buildSendAsCodeEmail } = await import('../email/send-as-code.ts');
  const mail = buildSendAsCodeEmail({ to: 'alias@icloud.example', inboxAddress: 'a&b@icloud.example', code: '042137' });
  assert.match(mail.subject, /^042137 /);
  assert.ok(mail.text.includes('042137'));
  assert.ok(mail.text.includes('alias@icloud.example'));
  assert.ok(mail.html.includes('a&#38;b@icloud.example'), 'addresses are HTML-escaped');
  assert.ok(!mail.html.includes('a&b@icloud.example'));
  assert.ok(mail.text.includes('15 minutes'), 'states the expiry the code really has');
  assert.equal(SEND_AS_CODE_TTL_MS, 15 * 60 * 1000);
  assert.equal(/—/.test(mail.text + mail.html + mail.subject), false, 'no em dash');
});
