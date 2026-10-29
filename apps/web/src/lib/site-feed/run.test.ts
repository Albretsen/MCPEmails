// The two site-feed jobs end to end, with Supabase and albretsen.no faked:
// internal workspaces (the synthetic monitor's among them) never reach the
// site, the country is k-anonymous, a 401 stops the run, the figure job posts
// on change and never lowers the site's figure, and the bearer key is never in
// a summary.
// Run: npm run test:site-feed
import assert from 'node:assert/strict';
import test from 'node:test';

import { siteRequest } from './client.ts';
import { loadEmailsHandled, runEventsJob, runFigureJob } from './run.ts';

process.env.GROWTH_INTERNAL_EMAILS = 'founder@example.test';

const KEY = 'feed_key_unit_secret';
const NOW = Date.UTC(2026, 9, 24, 12, 0, 20);

type Row = Record<string, unknown>;

/** Just enough of the PostgREST builder for run.ts. */
class FakeQuery {
  private filters: ((row: Row) => boolean)[] = [];
  private head = false;
  private max = Infinity;
  private rows: Row[];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  select(_columns: string, options?: { head?: boolean }) {
    this.head = options?.head === true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gte(column: string, value: string) {
    this.filters.push((row) => String(row[column]) >= value);
    return this;
  }
  lt(column: string, value: string) {
    this.filters.push((row) => String(row[column]) < value);
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  then<T>(resolve: (value: { data: Row[] | null; count: number | null; error: null }) => T) {
    const matched = this.rows.filter((row) => this.filters.every((f) => f(row))).slice(0, this.max);
    return Promise.resolve(resolve(this.head ? { data: null, count: matched.length, error: null } : { data: matched, count: null, error: null }));
  }
}

function fakeDb(tables: Record<string, Row[]>) {
  return { from: (table: string) => new FakeQuery(tables[table] ?? []) } as never;
}

type Sent = { url: string; method: string; auth: string | null; body: unknown };

function fakeSite(respond: (sent: Sent) => { status: number; body?: unknown } | 'network') {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const entry: Sent = {
      url,
      method: String(init.method),
      auth: headers.Authorization ?? null,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(entry);
    const answer = respond(entry);
    if (answer === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  }) as unknown as typeof fetch;
  return { sent, client: { fetchImpl, sleep: async () => {} } };
}

const IN_WINDOW = '2026-10-24T11:59:30.000Z';

function tables(): Record<string, Row[]> {
  const workspaces: Row[] = [
    { id: 'ws-ext', acquisition_country: 'NO', users: { email: 'someone@customer.test' } },
    { id: 'ws-founder', acquisition_country: 'NO', users: { email: 'founder+test@example.test' } },
    { id: 'ws-monitor', acquisition_country: null, users: { email: 'monitor@listed.test' } },
    { id: 'ws-domain', acquisition_country: null, users: { email: 'ops@mcpemails.com' } },
    { id: 'ws-se', acquisition_country: 'SE', users: { email: 'x@customer.test' } },
  ];
  for (let i = 0; i < 4; i += 1) workspaces.push({ id: `ws-no-${i}`, acquisition_country: 'NO', users: { email: `n${i}@c.test` } });
  return {
    internal_accounts: [{ email: 'monitor@listed.test' }],
    workspaces,
    activity_log: [
      { tool_name: 'email_send', duration_ms: 412, workspace_id: 'ws-ext', created_at: IN_WINDOW, status: 'success' },
      { tool_name: 'email_read', duration_ms: 90, workspace_id: 'ws-se', created_at: '2026-10-24T11:59:10.000Z', status: 'success' },
      { tool_name: 'inbox_list', duration_ms: 50, workspace_id: 'ws-monitor', created_at: IN_WINDOW, status: 'success' },
      { tool_name: 'email_reply', duration_ms: 50, workspace_id: 'ws-founder', created_at: IN_WINDOW, status: 'success' },
      { tool_name: 'email_forward', duration_ms: 50, workspace_id: 'ws-domain', created_at: IN_WINDOW, status: 'success' },
      { tool_name: 'email_send', duration_ms: 50, workspace_id: 'ws-ghost', created_at: IN_WINDOW, status: 'success' },
      { tool_name: 'draft_send', duration_ms: 50, workspace_id: 'ws-ext', created_at: IN_WINDOW, status: 'error' },
      { tool_name: 'email_reply', duration_ms: 50, workspace_id: 'ws-ext', created_at: '2026-10-24T12:00:05.000Z', status: 'success' },
      { tool_name: 'email_delete', duration_ms: 50, workspace_id: 'ws-ext', created_at: IN_WINDOW, status: 'success' },
    ],
    inboxes: [],
  };
}

test('events: only external activity from the window, k-anonymous country, oldest first', async () => {
  const site = fakeSite(() => ({ status: 200 }));
  const summary = await runEventsJob({ key: KEY, db: fakeDb(tables()), nowMs: NOW, random: () => 0, client: site.client });
  assert.deepEqual(site.sent.map((s) => s.body), [
    { product: 'mcp-emails', text: 'agent read an email', kind: 'email.read', ms: 90 },
    { product: 'mcp-emails', text: 'agent sent an email', kind: 'email.sent', ms: 412, country: 'NO' },
  ]);
  assert.ok(site.sent.every((s) => s.url === 'https://albretsen.no/api/events' && s.method === 'POST'));
  assert.ok(site.sent.every((s) => s.auth === `Bearer ${KEY}`));
  assert.deepEqual(summary, { job: 'events', candidates: 2, posted: 2, failed: 0 });
  assert.ok(!JSON.stringify(summary).includes(KEY));
});

test('events: a new inbox is posted, and a 401 stops the run', async () => {
  const t = tables();
  t.inboxes = [{ workspace_id: 'ws-se', created_at: IN_WINDOW, email_address: 'x@customer.test' }];
  const site = fakeSite(() => ({ status: 401 }));
  const summary = await runEventsJob({ key: KEY, db: fakeDb(t), nowMs: NOW, random: () => 0, client: site.client });
  assert.equal(site.sent.length, 1, 'no further posts after a 401, and 4xx is not retried');
  assert.equal(summary.reason, 'unauthorised');
  assert.equal(summary.posted, 0);
});

test('events: nothing in the window posts nothing', async () => {
  const site = fakeSite(() => ({ status: 200 }));
  const summary = await runEventsJob({ key: KEY, db: fakeDb({ ...tables(), activity_log: [] }), nowMs: NOW, client: site.client });
  assert.equal(site.sent.length, 0);
  assert.deepEqual(summary, { job: 'events', candidates: 0, posted: 0 });
});

test('events: a read failure is a summary, not a throw', async () => {
  const db = { from: () => { throw new Error('db down'); } } as never;
  const site = fakeSite(() => ({ status: 200 }));
  const summary = await runEventsJob({ key: KEY, db, nowMs: NOW, client: site.client });
  assert.equal(summary.reason, 'read_failed');
  assert.equal(site.sent.length, 0);
});

const figure = (value: number | string, updated: string, label = 'emails handled') => ({ figures: { 'mcp-emails': { label, value, updated } } });

test('figure: posts the emails handled string, with no unit, when it grew', async () => {
  const site = fakeSite((s) => (s.method === 'GET' ? { status: 200, body: figure('1.24 million+', new Date(NOW).toISOString()) } : { status: 200 }));
  const summary = await runFigureJob({ key: KEY, loadEmailsHandled: async () => 1_257_482, nowMs: NOW, client: site.client });
  assert.deepEqual(summary, { job: 'figure', posted: true });
  assert.equal(site.sent[0].auth, null, 'the GET carries no key');
  const post = site.sent[1];
  assert.equal(post.url, 'https://albretsen.no/api/figures');
  assert.equal(post.auth, `Bearer ${KEY}`);
  assert.deepEqual(post.body, { product: 'mcp-emails', label: 'emails handled', value: '1.25 million+' });
});

test('figure: replaces the old MRR figure', async () => {
  const site = fakeSite((s) => (s.method === 'GET' ? { status: 200, body: figure(10203.19, new Date(NOW).toISOString(), 'MRR') } : { status: 200 }));
  const summary = await runFigureJob({ key: KEY, loadEmailsHandled: async () => 1_257_482, nowMs: NOW, client: site.client });
  assert.deepEqual(summary, { job: 'figure', posted: true });
  assert.equal((site.sent[1].body as { label: string }).label, 'emails handled');
});

test('figure: the same string, freshly posted, is not reposted', async () => {
  const site = fakeSite(() => ({ status: 200, body: figure('1.25 million+', new Date(NOW - 3_600_000).toISOString()) }));
  const summary = await runFigureJob({ key: KEY, loadEmailsHandled: async () => 1_259_000, nowMs: NOW, client: site.client });
  assert.deepEqual(summary, { job: 'figure', posted: false, reason: 'unchanged' });
  assert.equal(site.sent.length, 1);
});

test('figure: a count below what the site shows is never posted', async () => {
  const site = fakeSite(() => ({ status: 200, body: figure('1.26 million+', new Date(NOW - 7 * 86_400_000).toISOString()) }));
  const summary = await runFigureJob({ key: KEY, loadEmailsHandled: async () => 1_257_482, nowMs: NOW, client: site.client });
  assert.deepEqual(summary, { job: 'figure', posted: false, reason: 'would_decrease' });
  assert.equal(site.sent.length, 1);
});

test('figure: a failed site read skips the run rather than risk a lower figure', async () => {
  const site = fakeSite((s) => (s.method === 'GET' ? 'network' : { status: 200 }));
  const summary = await runFigureJob({ key: KEY, loadEmailsHandled: async () => 1_257_482, nowMs: NOW, client: site.client });
  assert.deepEqual(summary, { job: 'figure', posted: false, reason: 'site_read_failed', status: 0 });
  assert.ok(site.sent.every((s) => s.method === 'GET'));
});

test('figure: a tiny count and a failed count read never post', async () => {
  const site = fakeSite(() => ({ status: 200 }));
  assert.equal((await runFigureJob({ key: KEY, loadEmailsHandled: async () => 0, nowMs: NOW, client: site.client })).reason, 'refused_too_small');
  const failed = await runFigureJob({ key: KEY, loadEmailsHandled: async () => { throw new Error('db down'); }, nowMs: NOW, client: site.client });
  assert.deepEqual(failed, { job: 'figure', posted: false, reason: 'read_failed' });
  assert.equal(site.sent.length, 0);
});

test('figure: a refused POST is a summary with the status, and no figure or key in it', async () => {
  const site = fakeSite((s) => (s.method === 'GET' ? { status: 200, body: { figures: {} } } : { status: 400 }));
  const summary = await runFigureJob({ key: KEY, loadEmailsHandled: async () => 1_257_482, nowMs: NOW, client: site.client });
  assert.deepEqual(summary, { job: 'figure', posted: false, reason: 'site_rejected', status: 400 });
  const text = JSON.stringify(summary);
  assert.ok(!text.includes(KEY) && !text.includes('million') && !text.includes('1257482'));
});

test('loadEmailsHandled: calls the RPC with the configured internal addresses and reads a number', async () => {
  const calls: { fn: string; args: unknown }[] = [];
  const db = (answer: { data: unknown; error: { message: string } | null }) =>
    ({ rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return answer; } }) as never;
  assert.equal(await loadEmailsHandled(db({ data: 1_257_482, error: null })), 1_257_482);
  assert.deepEqual(calls[0], { fn: 'site_feed_emails_handled', args: { p_internal_emails: ['founder@example.test'] } });
  // bigint can arrive as a string.
  assert.equal(await loadEmailsHandled(db({ data: '1340269', error: null })), 1_340_269);
  await assert.rejects(loadEmailsHandled(db({ data: null, error: { message: 'boom' } })), /boom/);
  await assert.rejects(loadEmailsHandled(db({ data: null, error: null })), /no number/);
});

test('client: retries a network error and a 5xx twice, then gives up without throwing', async () => {
  let calls = 0;
  const site = fakeSite(() => {
    calls += 1;
    return calls === 1 ? 'network' : { status: 503 };
  });
  const result = await siteRequest('/api/events', { method: 'POST', key: KEY, json: {} }, site.client);
  assert.equal(calls, 3);
  assert.deepEqual(result, { status: 503, ok: false, body: {} });

  let second = 0;
  const recovering = fakeSite(() => (++second < 2 ? { status: 502 } : { status: 200, body: { ok: true } }));
  assert.equal((await siteRequest('/api/events', { method: 'POST', key: KEY, json: {} }, recovering.client)).ok, true);
  assert.equal(second, 2);
});

test('client: a timeout is a status 0, not a throw', async () => {
  const fetchImpl = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const result = await siteRequest('/api/figures', { method: 'GET' }, { fetchImpl, sleep: async () => {}, timeoutMs: 20, retries: 0 });
  assert.deepEqual(result, { status: 0, ok: false });
});
