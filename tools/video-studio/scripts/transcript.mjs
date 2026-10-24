#!/usr/bin/env node
/**
 * Run a chat scene's tool calls against the REAL MCP server and write down
 * what actually came back.
 *
 *   npm run transcript -- --storyboard add-inbox-then-chat
 *   npm run transcript -- --storyboard add-inbox-then-chat --write
 *
 * The plan lives in transcripts/<id>.plan.json (data, with references to
 * earlier results: see scripts/lib/plan.mjs) or transcripts/<id>.plan.mjs
 * (code, for anything the JSON form cannot say). The JSON one wins when both
 * exist. This script executes every tool turn and writes
 * transcripts/<id>.json, which is what the Chat scene draws and what
 * render.mjs vets before it will draw anything at all.
 *
 * WHY THIS EXISTS, rather than someone typing a plausible transcript by hand:
 *
 * A production audit on 2026-08-19 found email_compose with 0 successes and 29
 * errors across 14 days, and email_organize, draft, folder and schedule with no
 * calls at all. Zero calls and zero failures are indistinguishable in a
 * dashboard and very distinguishable on camera. Anyone writing a transcript
 * from the tool documentation would have animated four features that had never
 * run and one that had never worked.
 *
 * So a turn's `ok` and `summary` are never authored. They are whatever the
 * server said, this week.
 *
 * Descended from scripts/demo/verify-demo-calls.js on branch
 * claude/brave-jackson-8180c8, which already handled the JSON-RPC-over-SSE
 * response shape this endpoint uses.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, fail, heading, log, parseArgs, paths, readJson, redact, loadEnv } from './lib/common.mjs';
import { READ_ONLY_TOOLS, fill, isEmpty, evaluate, loadJsonPlan } from './lib/plan.mjs';

loadEnv();
const args = parseArgs();
const id = args.storyboard ?? args._[0];
if (!id) fail('transcript', 'Pass a storyboard: npm run transcript -- --storyboard add-inbox-then-chat');

const ENDPOINT = process.env.MCP_ENDPOINT || 'https://mcpemails.com/api/mcp';
const KEY = process.env.MCP_API_KEY;
if (!KEY) {
  fail('transcript', 'MCP_API_KEY is not set. Create a scoped key in the dashboard and put it in .env.');
}

const jsonPlanFile = resolve(paths.transcripts, `${id}.plan.json`);
const planFile = resolve(paths.transcripts, `${id}.plan.mjs`);
let plan;
let planKind;
if (existsSync(jsonPlanFile)) {
  try {
    plan = loadJsonPlan(jsonPlanFile);
  } catch (e) {
    fail('transcript', e.message);
  }
  planKind = 'json';
} else if (existsSync(planFile)) {
  plan = await import(pathToFileURL(planFile).href);
  if (!Array.isArray(plan.turns)) fail('transcript', `transcripts/${id}.plan.mjs must export a "turns" array.`);
  planKind = 'mjs';
} else {
  fail('transcript', `Neither transcripts/${id}.plan.json nor transcripts/${id}.plan.mjs exists. A plan declares which calls this scene makes.`);
}

const WRITE = Boolean(args.write);

function readJsonSafe(file) {
  try {
    return existsSync(file) ? readJson(file) : null;
  } catch {
    return null;
  }
}

let requestId = 0;

/**
 * One JSON-RPC call. The server may answer as plain JSON or as SSE, so pull
 * the payload out of a `data:` line either way.
 */
async function call(method, params) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${KEY}`,
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    });
  } catch (e) {
    return { ok: false, kind: 'network', detail: e.message };
  }

  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  let body;
  try {
    body = JSON.parse(line ? line.slice(5).trim() : text);
  } catch {
    return { ok: false, kind: 'protocol', detail: `HTTP ${res.status}, unparseable body: ${redact(text.slice(0, 200))}` };
  }

  // A protocol error and a tool error are different failures and must not be
  // collapsed: one means the call never reached the tool, the other means the
  // tool ran and refused.
  if (body.error) return { ok: false, kind: 'protocol', detail: body.error };
  if (body.result?.isError) {
    const t = (body.result.content || []).map((c) => c.text || '').join(' ');
    return { ok: false, kind: 'tool', detail: t.slice(0, 300) };
  }
  return { ok: true, result: body.result };
}

const tool = (name, argsObj) => call('tools/call', { name, arguments: argsObj });

/** Tool payloads come back as JSON inside a text content block. */
function payloadOf(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

heading(`Verifying "${id}" against ${ENDPOINT}`);
if (!WRITE) log('  read-only. Pass --write to run mutating turns, demo mailbox only.');
log('');

const turns = [];
const results = [];
/** JSON plans: each tool turn's payload, by its `as` name. */
const named = {};
let failures = 0;

/**
 * Mutating calls run only against the demo mailbox. Checked once, before the
 * first mutating turn, by asking the server which inboxes this key can reach:
 * every one must be on a safe domain, or nothing mutating runs.
 */
/**
 * And only against VIDEO FIXTURE mail. The demo mailbox also holds the OpenAI
 * reviewer corpus, whose test cases check exact counts; a plan that archived
 * "every newsletter" would move the reviewer's DevWeekly and break them. So a
 * mutating call must name its messages by id, and every id must have been seen
 * in an earlier result as mail FROM a sender in fixtures/inbox.json.
 */
const fixtureSenders = new Set(
  readJsonSafe(resolve(paths.fixtures, 'inbox.json'))?.messages?.map((m) => m.from.toLowerCase()) ?? [],
);
const senderById = new Map();
function learnIds(value) {
  if (Array.isArray(value)) return value.forEach(learnIds);
  if (!value || typeof value !== 'object') return;
  const from = typeof value.from === 'object' ? value.from?.email : value.from;
  if (typeof value.id === 'string' && typeof from === 'string') senderById.set(value.id, from.toLowerCase());
  Object.values(value).forEach(learnIds);
}
function messageIdsIn(args) {
  const ids = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!/^(message_ids?|ids?)$/.test(k)) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string') ids.push(x);
  }
  return ids;
}
function fixtureOnly(args) {
  const ids = messageIdsIn(args);
  if (ids.length === 0) return { ok: false, why: 'a mutating call must name its messages by id (message_id or message_ids), so it cannot reach mail outside the video fixtures' };
  const foreign = ids.filter((id) => !fixtureSenders.has(senderById.get(id) ?? ''));
  return foreign.length
    ? { ok: false, why: `${foreign.length} message id(s) are not video fixture mail (see fixtures/inbox.json): ${foreign.slice(0, 3).join(', ')}` }
    : { ok: true };
}

let mutationGuard = null;
async function mutationAllowed() {
  if (mutationGuard) return mutationGuard;
  const safeDomains = (process.env.DEMO_SAFE_INBOX_DOMAINS ?? 'example')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = await tool('inbox_list', {});
  const list = out.ok ? (payloadOf(out.result)?.inboxes ?? []) : null;
  if (!Array.isArray(list) || list.length === 0) {
    mutationGuard = { ok: false, why: 'could not list the inboxes this key reaches' };
  } else {
    const unsafe = list
      .map((x) => String(x.email_address ?? ''))
      .filter((a) => !safeDomains.some((d) => a.toLowerCase().endsWith(`@${d}`) || a.toLowerCase().endsWith(`.${d}`)));
    mutationGuard = unsafe.length
      ? { ok: false, why: `this key reaches ${unsafe.length} inbox(es) outside DEMO_SAFE_INBOX_DOMAINS` }
      : { ok: true };
  }
  return mutationGuard;
}

for (const [i, turn] of plan.turns.entries()) {
  if (turn.role === 'user') {
    turns.push({ role: 'user', text: turn.text });
    log(`  [user] ${turn.text}`);
    continue;
  }

  if (turn.role === 'assistant') {
    // Held back until every tool turn has run, so an assistant line can be a
    // function of the real results rather than a guess about them.
    turns.push({ role: 'assistant', __resolve: turn });
    continue;
  }

  if (turn.role !== 'tool') fail('transcript', `plan turn ${i}: unknown role "${turn.role}".`);

  // JSON plans: fill references to earlier results. An argument that resolves
  // to nothing fails the turn instead of sending a call with a hole in it.
  let callArgs = turn.args ?? {};
  if (planKind === 'json') {
    let filled;
    try {
      filled = fill(callArgs, named);
    } catch (e) {
      filled = { value: callArgs, empty: [], error: e.message };
    }
    if (filled.error || filled.empty.length) {
      const why = filled.error ?? `{{${filled.empty[0]}}} resolved to nothing`;
      log(`  [FAIL] ${turn.name}: ${why}`);
      turns.push({ role: 'tool', name: turn.name, args: callArgs, ok: false, summary: `reference error: ${why}` });
      failures++;
      continue;
    }
    callArgs = filled.value;
  }

  const mutating = Boolean(turn.mutating) || (planKind === 'json' && !READ_ONLY_TOOLS.has(turn.name));
  if (mutating && !WRITE) {
    log(`  [skip] ${turn.name} is mutating, and --write was not passed`);
    turns.push({ role: 'tool', name: turn.name, args: callArgs, ok: false, summary: 'skipped: not run without --write' });
    failures++;
    continue;
  }
  if (mutating) {
    let guard = await mutationAllowed();
    if (guard.ok) guard = fixtureOnly(callArgs);
    if (!guard.ok) {
      log(`  [FAIL] ${turn.name}: refused, ${guard.why}`);
      turns.push({ role: 'tool', name: turn.name, args: callArgs, ok: false, summary: `refused: ${guard.why}` });
      failures++;
      continue;
    }
  }

  const began = performance.now();
  const outcome = await tool(turn.name, callArgs);
  const ms = Math.round(performance.now() - began);
  results.push({ name: turn.name, outcome });

  if (!outcome.ok) {
    failures++;
    const detail = redact(typeof outcome.detail === 'string' ? outcome.detail : JSON.stringify(outcome.detail));
    log(`  [FAIL] ${turn.name} ${JSON.stringify(turn.args ?? {})}`);
    log(`         ${outcome.kind}: ${detail.slice(0, 200)}`);
    turns.push({
      role: 'tool',
      name: turn.name,
      args: callArgs,
      ok: false,
      summary: `${outcome.kind} error: ${detail.slice(0, 160)}`,
      ms,
    });
    continue;
  }

  const payload = payloadOf(outcome.result);
  learnIds(payload);
  if (planKind === 'json' && turn.as) named[turn.as] = payload;
  let summary;
  try {
    if (planKind === 'json') {
      summary = turn.summary ? fill(turn.summary, named).value : 'ok';
    } else {
      summary = turn.summarize ? turn.summarize(payload) : 'ok';
    }
  } catch (e) {
    summary = `could not summarise: ${e.message}`;
  }

  log(`  [ok  ] ${turn.name} ${JSON.stringify(callArgs)} -> ${summary} (${ms}ms)`);
  turns.push({ role: 'tool', name: turn.name, args: callArgs, ok: true, summary: String(summary), ms });
}

// Resolve any assistant line that was written as a function of the results.
for (const turn of turns) {
  if (turn.role !== 'assistant') continue;
  const spec = turn.__resolve;
  delete turn.__resolve;

  if (planKind === 'json') {
    // An assistant line that cannot be filled is a failed turn, not a blank
    // bubble: the claim on screen would be unsupported.
    try {
      const has = spec.requires === undefined ? true : !isEmpty(evaluate(spec.requires, named)) && evaluate(spec.requires, named) !== 0;
      const filled = fill(has ? spec.text : spec.otherwise, named);
      if (filled.empty.length) throw new Error(`{{${filled.empty[0]}}} resolved to nothing`);
      turn.text = filled.value;
    } catch (e) {
      turn.text = spec.text;
      turn.ok = false;
      turn.summary = `reference error: ${e.message}`;
      failures++;
      log(`  [FAIL] assistant: ${e.message}`);
      continue;
    }
  } else {
    const value = spec.text;
    turn.text = typeof value === 'function' ? value(results.map((r) => payloadOf(r.outcome.result))) : value;
  }
  log(`  [asst] ${turn.text}`);
}

const doc = {
  id,
  verifiedAt: new Date().toISOString(),
  endpoint: ENDPOINT,
  turns,
};

const outPath = resolve(paths.transcripts, `${id}.json`);
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');

log('');
log(`  transcripts/${id}.json  ${turns.length} turns, ${failures} failed`);

if (failures) {
  log('');
  log('  Written anyway, with the failures recorded. render will REFUSE this');
  log('  transcript until every tool turn passes. Fix the call or cut the beat.');
  log('  Do not hand-edit ok:false to ok:true. That is the one thing this');
  log('  whole mechanism exists to prevent.');
}

emit({
  ok: failures === 0,
  script: 'transcript',
  id,
  file: `transcripts/${id}.json`,
  verifiedAt: doc.verifiedAt,
  turns: turns.length,
  toolCalls: turns.filter((t) => t.role === 'tool').length,
  failed: failures,
  renderable: failures === 0,
});

process.exit(failures === 0 ? 0 : 1);
