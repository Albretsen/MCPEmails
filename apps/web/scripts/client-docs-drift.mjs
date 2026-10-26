#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Client docs drift check. Run daily by .github/workflows/client-docs-drift.yml.
//
// Our per-client setup steps (dashboard guide, /docs/<client>, the install
// links in src/lib/clients/install-links.mjs) copy menu labels and link
// formats from vendor docs, and vendors rename things without telling anyone
// (ChatGPT "Developer mode" became "Plugins", Claude "Settings > Connectors"
// became "Customize > Connectors", Windsurf became Devin Desktop). This script
// notices for us:
//
//   (a) For every vendor page in client-docs-drift.baseline.json: fetch it,
//       extract the readable text, and compare
//         - the expected phrases (labels and URL patterns our steps rely on):
//           a phrase that is gone is DRIFT;
//         - a hash of the normalized text against the stored one: a changed
//           page is DRIFT, with an added/removed line summary against the
//           stored snapshot (client-docs-drift/<id>.txt).
//       A page that cannot be fetched is a WARNING, listed in the report but
//       never a reason to open an issue on its own (vendors rate-limit CI IPs).
//   (b) Our own install actions: every link and command from
//       getInstallAction() must decode to the production MCP URL, and that URL
//       must answer like our MCP server (401 + WWW-Authenticate on an
//       unauthenticated POST, and protected-resource metadata naming it).
//       A failure here is DRIFT.
//
// Output: a Markdown report on stdout. Exit 1 on drift, 0 otherwise (warnings
// included), 2 when the script itself crashed. The workflow opens or updates one issue labelled
// `client-docs-drift` on exit 1 and closes it on a clean run.
//
// HOW TO REFRESH THE BASELINE (after you have read the change and updated our
// copy, or decided it needs no change):
//
//   node apps/web/scripts/client-docs-drift.mjs --update
//
// That re-fetches every page and rewrites the stored hash, length, date and
// snapshot for each page it could fetch. It does NOT touch `phrases`: those
// are hand-kept. If a phrase was renamed by the vendor, edit it in
// client-docs-drift.baseline.json to the new wording (the one our copy now
// uses), then run --update. `--update` refuses to store a page whose phrases
// are missing, so a stale phrase cannot be baselined by accident; fix the
// phrase first. Commit the baseline and the snapshots in the same PR as the
// copy change. Add a page by appending an entry with id, client, url and
// phrases, then --update.
//
// Plain Node 24, no dependencies, so the workflow needs no npm ci.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getInstallAction, decodeInstallTarget, INSTALLABLE_CLIENTS } from '../src/lib/clients/install-links.mjs';
import { PRODUCTION_MCP_URL } from '../src/lib/clients/mcp-url.mjs';

const BASELINE_PATH = fileURLToPath(new URL('./client-docs-drift.baseline.json', import.meta.url));
const SNAPSHOT_DIR = fileURLToPath(new URL('./client-docs-drift/', import.meta.url));
const UA = 'Mozilla/5.0 (compatible; MCPEmails-docs-drift/1.0; +https://mcpemails.com)';
const MAX_DIFF_LINES = 12;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', rarr: '→' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Readable text of a page, one block per line. Prefers <main>, then
 * <article>, then <body>, so site navigation and footers (which change for
 * reasons that have nothing to do with MCP) mostly stay out of the hash.
 * Markdown pages (claude.com/docs/*.md) are used as they are.
 */
export function extractText(body, contentType = '') {
  if (!/html/i.test(contentType) && !/^\s*</.test(body)) {
    return normalizeLines(body.split('\n'));
  }
  let html = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ');
  for (const tag of ['main', 'article', 'body']) {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}>`, 'i'));
    if (m) { html = m[1]; break; }
  }
  // Drop chrome that sometimes sits inside <main>.
  html = html.replace(/<(nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, ' ');
  const text = html
    .replace(/<\/?(p|div|li|h[1-6]|tr|pre|br|section|ol|ul|table|blockquote|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeLines(decodeEntities(text).split('\n'));
}

function normalizeLines(lines) {
  return lines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n');
}

/** Hash input: lowercase, no digits (dates, counts, build ids), single spaces. */
export function normalizedHash(text) {
  const n = text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(n).digest('hex').slice(0, 16);
}

/** Phrases from `expected` that the text (or the raw page, for URL patterns) lacks. */
export function missingPhrases(text, raw, expected) {
  const hay = `${text}\n${decodeEntities(raw)}`.toLowerCase();
  return expected.filter((p) => !hay.includes(p.toLowerCase()));
}

/** Added and removed lines, set-wise, capped. Good enough to tell a reader where to look. */
export function lineDiff(before, after, max = MAX_DIFF_LINES) {
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  const removed = [...a].filter((l) => !b.has(l));
  const added = [...b].filter((l) => !a.has(l));
  return { added: added.slice(0, max), removed: removed.slice(0, max), addedCount: added.length, removedCount: removed.length };
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { raw, contentType: res.headers.get('content-type') ?? '', finalUrl: res.url };
}

/** (b) our own install actions and the live endpoint. Returns a list of problems. */
export async function checkOwnLinks({ live = true } = {}) {
  const problems = [];
  for (const slug of INSTALLABLE_CLIENTS) {
    const action = getInstallAction(slug, { mcpUrl: PRODUCTION_MCP_URL });
    if (!action) { problems.push(`${slug}: no install action`); continue; }
    if (action.kind === 'steps') continue;
    const target = decodeInstallTarget(action);
    if (target !== PRODUCTION_MCP_URL) problems.push(`${slug}: install ${action.kind} points at ${target ?? 'nothing'}, not ${PRODUCTION_MCP_URL}`);
    if (action.alt && decodeInstallTarget({ kind: 'link', href: action.alt.href }) !== PRODUCTION_MCP_URL) {
      problems.push(`${slug}: alternate link does not point at ${PRODUCTION_MCP_URL}`);
    }
  }
  if (!live) return problems;
  try {
    const res = await fetch(PRODUCTION_MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': UA },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      signal: AbortSignal.timeout(30_000),
    });
    const challenge = res.headers.get('www-authenticate') ?? '';
    if (res.status !== 401 || !/resource_metadata/i.test(challenge)) {
      problems.push(`${PRODUCTION_MCP_URL}: unauthenticated POST answered ${res.status} without an OAuth challenge (expected 401 + WWW-Authenticate resource_metadata)`);
    }
    const meta = await fetch(new URL('/.well-known/oauth-protected-resource/api/mcp', PRODUCTION_MCP_URL), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
    const json = meta.ok ? await meta.json().catch(() => null) : null;
    if (json?.resource !== PRODUCTION_MCP_URL) problems.push(`protected-resource metadata names ${json?.resource ?? 'nothing'} (HTTP ${meta.status}), not ${PRODUCTION_MCP_URL}`);
  } catch (error) {
    problems.push(`${PRODUCTION_MCP_URL}: unreachable (${error.message})`);
  }
  return problems;
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function snapshotPath(id) {
  return `${SNAPSHOT_DIR}${id}.txt`;
}

async function update() {
  const baseline = readBaseline();
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  let refused = 0;
  for (const source of baseline.sources) {
    try {
      const { raw, contentType } = await fetchPage(source.url);
      const text = extractText(raw, contentType);
      const missing = missingPhrases(text, raw, source.phrases);
      if (missing.length) {
        refused += 1;
        console.error(`${source.id}: NOT updated, phrases missing: ${missing.map((p) => JSON.stringify(p)).join(', ')}`);
        continue;
      }
      source.hash = normalizedHash(text);
      source.length = text.length;
      source.checkedAt = new Date().toISOString().slice(0, 10);
      writeFileSync(snapshotPath(source.id), `${text}\n`);
      console.error(`${source.id}: stored (${text.length} chars)`);
    } catch (error) {
      refused += 1;
      console.error(`${source.id}: NOT updated, fetch failed: ${error.message}`);
    }
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  process.exitCode = refused ? 1 : 0;
}

async function check() {
  const baseline = readBaseline();
  const drift = [];
  const warnings = [];
  const fresh = [];
  for (const source of baseline.sources) {
    let page;
    try {
      page = await fetchPage(source.url);
    } catch (error) {
      warnings.push(`- **${source.id}** (${source.client}): could not fetch ${source.url}: ${error.message}`);
      continue;
    }
    const text = extractText(page.raw, page.contentType);
    const missing = missingPhrases(text, page.raw, source.phrases);
    const hash = normalizedHash(text);
    const changed = source.hash && hash !== source.hash;
    if (!missing.length && !changed) { fresh.push(source.id); continue; }
    const lines = [`### ${source.id} (${source.client})`, `${source.url}`, ''];
    if (missing.length) lines.push(`Expected phrases no longer on the page: ${missing.map((p) => `\`${p}\``).join(', ')}`, '');
    if (changed) {
      lines.push(`Page text changed since ${source.checkedAt ?? 'the baseline'} (hash ${source.hash} -> ${hash}, ${source.length ?? '?'} -> ${text.length} chars).`);
      const snap = snapshotPath(source.id);
      if (existsSync(snap)) {
        const d = lineDiff(readFileSync(snap, 'utf8').trim(), text);
        if (d.removedCount) lines.push('', `Removed (${d.removedCount}):`, ...d.removed.map((l) => `- ${l.slice(0, 200)}`));
        if (d.addedCount) lines.push('', `Added (${d.addedCount}):`, ...d.added.map((l) => `+ ${l.slice(0, 200)}`));
      }
      lines.push('');
    }
    drift.push(lines.join('\n'));
  }
  const own = await checkOwnLinks();

  const out = ['# Client setup docs drift', '', `Run: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ''];
  if (!drift.length && !own.length) {
    out.push('No drift. Every vendor page that could be fetched still matches the baseline, and every install link points at the live MCP URL.');
  } else {
    out.push(
      'A vendor page our client setup steps rely on has changed, or one of our install links is broken.',
      'Read the change, update the copy (messages/<locale>/dashboard.json `clients.*`, src/lib/clients/content, src/lib/clients/install-links.mjs) if it matters,',
      'then refresh the baseline: `node apps/web/scripts/client-docs-drift.mjs --update` (see the script header).',
      '',
    );
  }
  if (own.length) out.push('## Our install links', '', ...own.map((p) => `- ${p}`), '');
  if (drift.length) out.push('## Vendor pages', '', ...drift);
  if (warnings.length) out.push('## Fetch warnings (not drift on their own)', '', ...warnings, '');
  if (fresh.length) out.push(`Unchanged: ${fresh.join(', ')}.`);
  console.log(out.join('\n'));
  process.exitCode = drift.length || own.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes('--update')) await update();
    else await check();
  } catch (error) {
    // Exit 2, not 1: the workflow reads 1 as drift and would open an issue.
    console.error(error);
    process.exitCode = 2;
  }
}
