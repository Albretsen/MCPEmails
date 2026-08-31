#!/usr/bin/env node
/**
 * Run a chat scene's tool calls against the REAL MCP server and write down
 * what actually came back.
 *
 *   npm run transcript -- --storyboard add-inbox-then-chat
 *   npm run transcript -- --storyboard add-inbox-then-chat --write
 *
 * The plan lives in transcripts/<id>.plan.mjs. This script executes every tool
 * turn in it and writes transcripts/<id>.json, which is what the Chat scene
 * draws and what render.mjs vets before it will draw anything at all.
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
import { emit, fail, heading, log, parseArgs, paths, redact, loadEnv } from './lib/common.mjs';

loadEnv();
const args = parseArgs();
const id = args.storyboard ?? args._[0];
if (!id) fail('transcript', 'Pass a storyboard: npm run transcript -- --storyboard add-inbox-then-chat');

const ENDPOINT = process.env.MCP_ENDPOINT || 'https://mcpemails.com/api/mcp';
const KEY = process.env.MCP_API_KEY;
if (!KEY) {
  fail('transcript', 'MCP_API_KEY is not set. Create a scoped key in the dashboard and put it in .env.');
}

const planFile = resolve(paths.transcripts, `${id}.plan.mjs`);
if (!existsSync(planFile)) {
  fail('transcript', `transcripts/${id}.plan.mjs does not exist. It declares which calls this scene makes.`);
}
const plan = await import(pathToFileURL(planFile).href);
if (!Array.isArray(plan.turns)) fail('transcript', `transcripts/${id}.plan.mjs must export a "turns" array.`);

const WRITE = Boolean(args.write);

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
let failures = 0;

for (const [i, turn] of plan.turns.entries()) {
  if (turn.role === 'user') {
    turns.push({ role: 'user', text: turn.text });
    log(`  [user] ${turn.text}`);
    continue;
  }

  if (turn.role === 'assistant') {
    // Held back until every tool turn has run, so an assistant line can be a
    // function of the real results rather than a guess about them.
    turns.push({ role: 'assistant', __resolve: turn.text });
    continue;
  }

  if (turn.role !== 'tool') fail('transcript', `plan turn ${i}: unknown role "${turn.role}".`);

  if (turn.mutating && !WRITE) {
    log(`  [skip] ${turn.name} is mutating, and --write was not passed`);
    turns.push({ role: 'tool', name: turn.name, args: turn.args ?? {}, ok: false, summary: 'skipped: not run without --write' });
    failures++;
    continue;
  }

  const outcome = await tool(turn.name, turn.args ?? {});
  results.push({ name: turn.name, outcome });

  if (!outcome.ok) {
    failures++;
    const detail = redact(typeof outcome.detail === 'string' ? outcome.detail : JSON.stringify(outcome.detail));
    log(`  [FAIL] ${turn.name} ${JSON.stringify(turn.args ?? {})}`);
    log(`         ${outcome.kind}: ${detail.slice(0, 200)}`);
    turns.push({
      role: 'tool',
      name: turn.name,
      args: turn.args ?? {},
      ok: false,
      summary: `${outcome.kind} error: ${detail.slice(0, 160)}`,
    });
    continue;
  }

  const payload = payloadOf(outcome.result);
  let summary;
  try {
    summary = turn.summarize ? turn.summarize(payload) : 'ok';
  } catch (e) {
    summary = `could not summarise: ${e.message}`;
  }

  log(`  [ok  ] ${turn.name} ${JSON.stringify(turn.args ?? {})} -> ${summary}`);
  turns.push({ role: 'tool', name: turn.name, args: turn.args ?? {}, ok: true, summary: String(summary) });
}

// Resolve any assistant line that was written as a function of the results.
for (const turn of turns) {
  if (turn.role !== 'assistant') continue;
  const value = turn.__resolve;
  delete turn.__resolve;
  turn.text = typeof value === 'function' ? value(results.map((r) => payloadOf(r.outcome.result))) : value;
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
