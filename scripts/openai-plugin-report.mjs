#!/usr/bin/env node
/**
 * OpenAI plugin read-out ("Any Mailbox" in the ChatGPT and Codex directory,
 * published 2026-11-17 UTC).
 *
 *   node scripts/openai-plugin-report.mjs [days]   (default 21)
 *
 * Calls public.openai_plugin_daily and public.openai_plugin_window
 * (migration 20261116120000_openai_plugin_measurement.sql) with the service
 * role and prints one row per Europe/Oslo day, the last two full Oslo weeks,
 * and the pre-publish baseline. Read-only.
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the
 * environment, else from the file named by MCPEMAILS_ENV_FILE, else from
 * apps/web/.env.local. The days are fetched in 7-day chunks: a cold 30-day
 * scan of activity_log comes close to PostgREST's 8 s statement timeout.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(process.env.MCPEMAILS_ENV_FILE);
loadEnvFile(resolve(repoRoot, 'apps/web/.env.local'));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (set MCPEMAILS_ENV_FILE to apps/web/.env.local).');
  process.exit(1);
}

const PUBLISHED_AT = new Date('2026-11-17T00:00:00Z');
const BASELINE = {
  week: 'week of 2026-11-09 (Oslo)',
  chatgptSignups: 51,
  signups: 395,
  openaiActive7d: 326,
  active7d: 1116,
  activeWindow: '7 days to 2026-11-16',
};

const days = Math.max(1, Math.min(366, Number(process.argv[2]) || 21));
const TZ = 'Europe/Oslo';

async function rpc(name, args) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** YYYY-MM-DD of a Date in Oslo. */
function osloDay(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant an Oslo calendar day starts, as an ISO string with offset. */
function osloMidnight(day) {
  // Try both offsets Oslo uses and keep the one that lands on 00:00 Oslo.
  for (const off of ['+01:00', '+02:00']) {
    const d = new Date(`${day}T00:00:00${off}`);
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    if (hm === '00:00' && osloDay(d) === day) return d.toISOString();
  }
  throw new Error(`no Oslo midnight for ${day}`);
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');

const today = osloDay(new Date());
const rows = [];
for (let end = today, left = days; left > 0; ) {
  const chunk = Math.min(7, left);
  const part = await rpc('openai_plugin_daily', { p_days: chunk, p_end_day: end });
  rows.unshift(...part);
  left -= chunk;
  end = addDays(end, -chunk);
}

const publishedDay = osloDay(PUBLISHED_AT);
const cols = [
  ['day', 10, (r) => r.day + (r.day === publishedDay ? '*' : '')],
  ['signups', 7, (r) => r.signups],
  ['gpt_sgn', 7, (r) => r.chatgpt_signups],
  ['inbox24', 7, (r) => r.inbox_within_24h],
  ['call24', 6, (r) => r.first_call_within_24h],
  ['paid', 4, (r) => r.paid_now],
  ['install', 7, (r) => r.installs],
  ['active', 6, (r) => r.active_workspaces],
  ['oai_ws', 6, (r) => r.openai_active],
  ['gpt_ws', 6, (r) => r.chatgpt_active],
  ['cdx_ws', 6, (r) => r.codex_active],
  ['oai_calls', 9, (r) => r.openai_calls],
  ['err%', 6, (r) => (r.openai_error_rate == null ? '-' : `${(100 * Number(r.openai_error_rate)).toFixed(1)}`)],
  ['cap_ws', 6, (r) => r.openai_free_cap_hits],
];
const line = (vals) => vals.map((v, i) => String(v).padStart(cols[i][1] + (i ? 1 : 0))).join(' ');

console.log(`OpenAI plugin read-out, ${days} days to ${today} (Oslo days). Published ${publishedDay} (*), 2026-11-17 01:00 Oslo (00:00 UTC).`);
console.log(`Generated ${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }).format(new Date())} Oslo.\n`);
console.log(line(cols.map((c) => c[0])));
for (const r of rows) console.log(line(cols.map((c) => c[2](r))));

// Last two full Oslo weeks (Mon..Sun) plus the current partial week.
const weekStart = (day) => {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
};
const thisWeek = weekStart(today);
const weeks = [addDays(thisWeek, -14), addDays(thisWeek, -7), thisWeek];
console.log('\nWeeks (Mon-Sun, Oslo):');
for (const ws of weeks) {
  const we = addDays(ws, 7);
  const inWeek = rows.filter((r) => r.day >= ws && r.day < we);
  const sum = (k) => inWeek.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const to = we > today ? new Date().toISOString() : osloMidnight(we);
  const [w] = await rpc('openai_plugin_window', { p_from: osloMidnight(ws), p_to: to });
  const partial = we > today ? ' (so far)' : '';
  console.log(
    `  ${ws}${partial}: ChatGPT signups ${sum('chatgpt_signups')}/${sum('signups')} (${pct(sum('chatgpt_signups'), sum('signups'))}),`
      + ` installs ${sum('installs')}, inbox<24h ${sum('inbox_within_24h')}, first call<24h ${sum('first_call_within_24h')}, paid ${sum('paid_now')};`
      + ` OpenAI-active ${w.openai_active}/${w.active_workspaces} (${pct(w.openai_active, w.active_workspaces)}; ChatGPT ${w.chatgpt_active}, Codex ${w.codex_active}),`
      + ` OpenAI calls ${w.openai_calls} (${pct(w.openai_errors, w.openai_calls)} errors)`,
  );
}

console.log('\nBaseline before publishing:');
console.log(`  ${BASELINE.week}: ${BASELINE.chatgptSignups} ChatGPT-tagged signups of ${BASELINE.signups} (${pct(BASELINE.chatgptSignups, BASELINE.signups)})`);
console.log(`  ${BASELINE.activeWindow}: ${BASELINE.openaiActive7d} of ${BASELINE.active7d} active workspaces used an OpenAI client (${pct(BASELINE.openaiActive7d, BASELINE.active7d)})`);
console.log('\nColumns: gpt_sgn = new workspaces from chatgpt / chatgpt_directory / connector_chatgpt; inbox24, call24, paid = of those (paid = now);');
console.log('install = new OAuth keys named for ChatGPT or Codex; oai_ws = workspaces with a call on an OpenAI key; cap_ws = of those, refused by the Free cap.');
