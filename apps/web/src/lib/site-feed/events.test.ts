// The albretsen.no activity ticker: anonymisation and per-run sampling.
// Run: npm run test:site-feed
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COUNTRY_K,
  FEED_TOOL_NAMES,
  OUTBOUND_TOOL_NAMES,
  PRIORITY_KINDS,
  TOOL_PHRASES,
  feedWindow,
  selectFeedEvents,
  toFeedEvent,
} from './events.ts';

const ALLOWED_KEYS = new Set(['product', 'text', 'kind', 'ms', 'country']);

test('a tool call becomes exactly product, text, kind and ms', () => {
  const event = toFeedEvent({ source: 'activity_log', tool_name: 'email_send', duration_ms: 412 });
  assert.deepEqual(event, { product: 'mcp-emails', text: 'agent sent an email', kind: 'email.sent', ms: 412 });
});

test('a new inbox row becomes the connected line, with no duration', () => {
  const event = toFeedEvent({ source: 'inboxes', duration_ms: 300 });
  assert.deepEqual(event, { product: 'mcp-emails', text: 'a new inbox was connected', kind: 'inbox.connected' });
});

test('the mapping for the tools the brief names', () => {
  const text = (tool: string) => toFeedEvent({ source: 'activity_log', tool_name: tool })?.text;
  assert.equal(text('email_send'), 'agent sent an email');
  assert.equal(text('email_reply'), 'agent replied to an email');
  assert.equal(text('email_forward'), 'agent forwarded an email');
  assert.equal(text('draft_create'), 'agent drafted an email');
  assert.equal(text('draft_send'), 'agent sent a draft');
  assert.equal(text('schedule_create'), 'agent scheduled an email');
  assert.equal(text('email_search'), 'agent searched an inbox');
  assert.equal(text('email_read'), 'agent read an email');
  assert.equal(text('email_move_batch'), 'agent sorted an inbox');
  assert.equal(text('inbox_list'), 'agent checked its inboxes');
  // Legacy consolidated names that older rows still carry.
  assert.equal(text('email_compose'), 'agent sent an email');
  assert.equal(text('email_organize'), 'agent sorted an inbox');
});

test('every phrase fits the site limits and kinds are short and stable', () => {
  for (const [tool, phrase] of Object.entries(TOOL_PHRASES)) {
    assert.ok(phrase.text.length > 0 && phrase.text.length <= 80, tool);
    assert.match(phrase.kind, /^[a-z]+\.[a-z]+$/, tool);
    assert.ok(phrase.kind.length <= 40, tool);
  }
  assert.deepEqual([...FEED_TOOL_NAMES].sort(), Object.keys(TOOL_PHRASES).sort());
  for (const tool of OUTBOUND_TOOL_NAMES) assert.ok(PRIORITY_KINDS.includes(TOOL_PHRASES[tool].kind), tool);
});

test('unknown, destructive, triage and malformed tools are dropped', () => {
  for (const tool of ['email_delete', 'email_search_and_delete', 'folder_delete', 'automation_create', 'triage_move',
    'signature_set', 'toString', '__proto__', 'constructor', '', 'EMAIL_SEND']) {
    assert.equal(toFeedEvent({ source: 'activity_log', tool_name: tool }), null, tool);
  }
  assert.equal(toFeedEvent({ source: 'activity_log', tool_name: 42 }), null);
  assert.equal(toFeedEvent({ source: 'activity_log' }), null);
  assert.equal(toFeedEvent({ source: 'somewhere' as 'inboxes', tool_name: 'email_send' }), null);
});

test('ms is an integer strictly between 0 and 120000, else omitted', () => {
  const ms = (duration: unknown) => toFeedEvent({ source: 'activity_log', tool_name: 'email_read', duration_ms: duration })?.ms;
  assert.equal(ms(1), 1);
  assert.equal(ms(411.6), 412);
  assert.equal(ms(119_999), 119_999);
  for (const bad of [0, -5, 120_000, 500_000, null, undefined, '412', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(ms(bad), undefined, String(bad));
  }
});

test('country is sent only at or above the k threshold, and only as alpha-2', () => {
  const country = (code: unknown, shared: unknown) =>
    toFeedEvent(
      { source: 'activity_log', tool_name: 'email_send' },
      { country: code as string, countryWorkspaces: shared as number },
    )?.country;
  assert.equal(COUNTRY_K, 5);
  assert.equal(country('NO', 5), 'NO');
  assert.equal(country('no', 12), 'NO');
  assert.equal(country('NO', 4), undefined);
  assert.equal(country('NO', 0), undefined);
  assert.equal(country('NO', null), undefined);
  assert.equal(country(null, 50), undefined);
  assert.equal(country('NOR', 50), undefined);
  assert.equal(country('N1', 50), undefined);
});

test('a row stuffed with personal data yields none of it', () => {
  const row = {
    source: 'activity_log' as const,
    tool_name: 'email_reply',
    duration_ms: 812,
    id: 'act_7f3c2b10-aaaa-4bbb-8ccc-123456789abc',
    workspace_id: 'ws-11111111-2222-4333-8444-555555555555',
    api_key_id: 'key-66666666-7777-4888-9999-000000000000',
    inbox_id: 'inbox-abcdefab-cdef-4abc-8def-abcdefabcdef',
    to: 'alice.secret@example.com',
    from: 'bob.private@example.org',
    subject: 'Quarterly salary review CONFIDENTIAL',
    owner_name: 'Carol Customer',
    user_agent: 'Claude-Desktop/9.9 (Macintosh)',
    ip_address: '203.0.113.7',
    created_at: '2026-10-24T11:59:31.123Z',
    error_details: { recipient: 'dave@example.net' },
  };
  const event = toFeedEvent(row, { country: 'SE', countryWorkspaces: 9 });
  assert.ok(event);
  for (const key of Object.keys(event)) assert.ok(ALLOWED_KEYS.has(key), key);
  const json = JSON.stringify(event);
  for (const leaked of ['alice', 'bob', 'example', 'salary', 'Carol', 'Claude-Desktop', '203.0.113', '2026-10-24',
    '11111111', '66666666', 'abcdefab', 'act_', 'dave', '@']) {
    assert.ok(!json.includes(leaked), leaked);
  }
  assert.deepEqual(event, { product: 'mcp-emails', text: 'agent replied to an email', kind: 'email.replied', ms: 812, country: 'SE' });
});

/** Deterministic generator (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const c = (kind: string, id: number) => ({ kind, id });

test('empty input selects nothing', () => {
  assert.deepEqual(selectFeedEvents([], { random: seeded(1) }), []);
  assert.deepEqual(selectFeedEvents([c('email.read', 1)], { max: 0, random: seeded(1) }), []);
});

test('never more than max, three by default', () => {
  const many = Array.from({ length: 50 }, (_, i) => c(['email.read', 'inbox.searched', 'inbox.opened', 'inbox.sorted'][i % 4], i));
  assert.equal(selectFeedEvents(many, { random: seeded(2) }).length, 3);
  assert.equal(selectFeedEvents(many, { max: 2, random: seeded(2) }).length, 2);
  assert.equal(selectFeedEvents(many.slice(0, 2), { random: seeded(2) }).length, 2);
});

test('variety: no kind twice while another kind is available', () => {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => c('inbox.searched', i)),
    c('email.read', 100),
    c('inbox.opened', 101),
  ];
  for (let seed = 1; seed <= 25; seed += 1) {
    const kinds = selectFeedEvents(rows, { random: seeded(seed) }).map((row) => row.kind).sort();
    assert.deepEqual(kinds, ['email.read', 'inbox.opened', 'inbox.searched'], `seed ${seed}`);
  }
});

test('a kind repeats only when nothing else is left', () => {
  const rows = Array.from({ length: 10 }, (_, i) => c('email.read', i));
  const picked = selectFeedEvents(rows, { random: seeded(3) });
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((row) => row.id)).size, 3);
});

test('priority: a new inbox and outbound sends win slots over common reads', () => {
  const rows = [
    ...Array.from({ length: 100 }, (_, i) => c(['email.read', 'inbox.searched', 'inbox.opened'][i % 3], i)),
    c('email.sent', 200),
    c('inbox.connected', 201),
  ];
  for (let seed = 1; seed <= 25; seed += 1) {
    const kinds = selectFeedEvents(rows, { random: seeded(seed) }).map((row) => row.kind);
    assert.ok(kinds.includes('inbox.connected'), `seed ${seed}`);
    assert.ok(kinds.includes('email.sent'), `seed ${seed}`);
  }
  const fourPriority = [c('draft.sent', 1), c('email.forwarded', 2), c('email.replied', 3), c('email.sent', 4), c('inbox.connected', 5)];
  assert.deepEqual(
    selectFeedEvents(fourPriority, { random: seeded(4) }).map((row) => row.kind),
    ['email.replied', 'email.sent', 'inbox.connected'],
  );
});

test('deterministic for a given random, and the result keeps input order', () => {
  const rows = Array.from({ length: 30 }, (_, i) => c(['email.read', 'inbox.searched', 'inbox.opened', 'inbox.sorted', 'email.drafted'][i % 5], i));
  const first = selectFeedEvents(rows, { random: seeded(42) });
  const second = selectFeedEvents(rows, { random: seeded(42) });
  assert.deepEqual(first, second);
  const ids = first.map((row) => row.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  // A different seed can pick differently; the sampler really uses `random`.
  const seen = new Set<string>();
  for (let seed = 1; seed <= 30; seed += 1) seen.add(JSON.stringify(selectFeedEvents(rows, { random: seeded(seed) })));
  assert.ok(seen.size > 1);
});

test('a broken random cannot index out of range', () => {
  const rows = [c('email.read', 1), c('inbox.searched', 2)];
  for (const value of [1, 5, -1, Number.NaN]) {
    const picked = selectFeedEvents(rows, { random: () => value });
    assert.equal(picked.length, 2, String(value));
    assert.ok(picked.every(Boolean));
  }
});

test('the window is the previous whole minute', () => {
  assert.deepEqual(feedWindow(Date.UTC(2026, 9, 24, 12, 0, 37, 500)), {
    start: '2026-10-24T11:59:00.000Z',
    end: '2026-10-24T12:00:00.000Z',
  });
  assert.deepEqual(feedWindow(Date.UTC(2026, 9, 24, 12, 0, 0, 0)), {
    start: '2026-10-24T11:59:00.000Z',
    end: '2026-10-24T12:00:00.000Z',
  });
});
