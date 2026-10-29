#!/usr/bin/env node
// state-brief-render.mjs: turns brief.json (written by the model from
// state.json) into the HTML page published as the private "state of the
// project" artifact. Enforces the brief's rules mechanically: every bullet
// needs at least one source, "Needs you" holds at most 7 bullets, and dropped
// bullets are counted on the page instead of disappearing silently.
//
// brief.json:
// {
//   "generated_at": "2026-10-20T16:00:00Z",
//   "changed": "One or two sentences on what moved since the last brief.",
//   "sections": {
//     "needs_you":  [Bullet], "due_7d": [Bullet],
//     "in_flight":  [Bullet], "shipped": [Bullet]
//   }
// }
// Bullet: { "text": "...", "meta": "short tag, optional",
//           "status": "bad" | "warn" | "ok" | "info" (optional),
//           "sources": ["https://github.com/.../pull/123" | "memory/file.md:12", ...] }
//
// Usage: node scripts/state-brief-render.mjs <brief.json> <out.html>

import fs from 'node:fs'

const [, , inFile, outFile] = process.argv
if (!inFile || !outFile) {
  console.error('usage: state-brief-render.mjs <brief.json> <out.html>')
  process.exit(2)
}
const brief = JSON.parse(fs.readFileSync(inFile, 'utf8'))

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const SECTIONS = [
  ['needs_you', 'Needs you', 'Oldest first. Decisions, reviews and checks only you can do.', 7],
  ['due_7d', 'Due in 7 days', 'Read-outs, checks and deadlines with a date in the next week.', Infinity],
  ['in_flight', 'In flight', 'Open PRs and worktrees still moving.', Infinity],
  ['shipped', 'Shipped since last brief', 'Merged PRs.', Infinity],
]

function sourceHtml(src) {
  const pr = src.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
  if (pr) return `<a class="src" href="${esc(src)}" target="_blank" rel="noopener">#${pr[1]}</a>`
  if (/^https?:\/\//.test(src)) return `<a class="src" href="${esc(src)}" target="_blank" rel="noopener">${esc(src.replace(/^https?:\/\//, ''))}</a>`
  return `<code class="src">${esc(src)}</code>`
}

let dropped = 0
let total = 0
const sectionsHtml = SECTIONS.map(([key, title, hint, cap]) => {
  const all = brief.sections?.[key] ?? []
  const valid = all.filter((b) => b && b.text && Array.isArray(b.sources) && b.sources.filter(Boolean).length)
  dropped += all.length - valid.length
  const shown = valid.slice(0, cap)
  const over = valid.length - shown.length
  total += shown.length
  const items = shown
    .map(
      (b) => `<li class="item" data-status="${esc(b.status ?? 'info')}">
  <span class="dot" aria-hidden="true"></span>
  <div class="body">
    <p class="text">${esc(b.text)}</p>
    <p class="srcs">${b.meta ? `<span class="meta">${esc(b.meta)}</span>` : ''}${b.sources.filter(Boolean).map(sourceHtml).join('')}</p>
  </div>
</li>`,
    )
    .join('\n')
  return `<section class="sec" id="${key}">
  <header class="sec-head"><h2>${esc(title)}</h2><span class="count">${shown.length}</span></header>
  <p class="hint">${esc(hint)}</p>
  ${shown.length ? `<ul class="list">${items}</ul>` : '<p class="empty">Nothing here.</p>'}
  ${over > 0 ? `<p class="hint">${over} more not shown (cap ${cap}).</p>` : ''}
</section>`
}).join('\n')

const generated = new Date(brief.generated_at ?? Date.now())
const stamp = generated.toLocaleString('en-GB', { timeZone: 'Europe/Oslo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const html = `<title>MCPEmails State</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* Layout: one narrow reading column, a status line, then four stacked lists that read like a ship's log. */
:root {
  --bg: #f5f7f8; --panel: #ffffff; --fg: #17222b; --muted: #5d6b76; --rule: #dde3e7;
  --accent: #1f5f8b; --bad: #b4232c; --warn: #a86300; --ok: #2b7a4b; --info: #8a98a3;
  --sans: "Instrument Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #11171c; --panel: #172028; --fg: #e3e9ee; --muted: #93a2ae; --rule: #26323c;
  --accent: #7cb7e0; --bad: #f0727a; --warn: #e3a64a; --ok: #6cc391; --info: #6f7f8b; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #11171c; --panel: #172028; --fg: #e3e9ee; --muted: #93a2ae; --rule: #26323c;
  --accent: #7cb7e0; --bad: #f0727a; --warn: #e3a64a; --ok: #6cc391; --info: #6f7f8b; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 var(--sans); }
.wrap { max-width: 46rem; margin: 0 auto; padding: 2rem 16px 3rem; display: grid; gap: 1.75rem; }
.top { display: grid; gap: .35rem; }
.eyebrow { font: 500 .72rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 0; font-size: 1.75rem; font-weight: 700; letter-spacing: -.01em; text-wrap: balance; }
.changed { margin: .5rem 0 0; padding: .75rem .9rem; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; }
.changed b { color: var(--accent); font-weight: 600; }
nav.jump { display: flex; flex-wrap: wrap; gap: .4rem 1rem; font: .8rem var(--mono); }
nav.jump a { color: var(--accent); text-decoration: none; }
nav.jump a:hover, nav.jump a:focus-visible { text-decoration: underline; }
.sec { display: grid; gap: .4rem; }
.sec-head { display: flex; align-items: baseline; gap: .6rem; border-bottom: 1px solid var(--rule); padding-bottom: .35rem; }
h2 { margin: 0; font-size: 1.1rem; font-weight: 600; }
.count { font: 500 .8rem var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.hint, .empty { margin: 0; color: var(--muted); font-size: .85rem; }
.list { list-style: none; margin: 0; padding: 0; display: grid; }
.item { display: grid; grid-template-columns: .9rem 1fr; gap: .5rem; padding: .6rem 0; border-bottom: 1px dashed var(--rule); }
.item:last-child { border-bottom: 0; }
.dot { width: .55rem; height: .55rem; border-radius: 50%; margin-top: .45rem; background: var(--info); }
.item[data-status="bad"] .dot { background: var(--bad); }
.item[data-status="warn"] .dot { background: var(--warn); }
.item[data-status="ok"] .dot { background: var(--ok); }
.body { min-width: 0; display: grid; gap: .2rem; }
.text { margin: 0; }
.srcs { margin: 0; display: flex; flex-wrap: wrap; gap: .3rem .6rem; font: .76rem/1.4 var(--mono); color: var(--muted); }
.meta { color: var(--fg); font-weight: 500; }
.src { overflow-wrap: anywhere; }
a.src { color: var(--accent); }
a.src:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code.src { font: inherit; }
.foot { color: var(--muted); font: .76rem var(--mono); border-top: 1px solid var(--rule); padding-top: .75rem; }
</style>
<main class="wrap">
  <div class="top">
    <span class="eyebrow">State brief &middot; ${esc(stamp)} Oslo</span>
    <h1>MCPEmails state</h1>
    <p class="changed"><b>Changed since last brief:</b> ${esc(brief.changed || 'First brief, nothing to compare yet.')}</p>
  </div>
  <nav class="jump" aria-label="Sections">${SECTIONS.map(([k, t]) => `<a href="#${k}">${esc(t)}</a>`).join('')}</nav>
  ${sectionsHtml}
  <p class="foot">${total} items, every one with a source. Built from scripts/state-snapshot.mjs output${dropped ? `; ${dropped} item${dropped === 1 ? '' : 's'} without a source left out` : ''}.</p>
</main>
`
fs.writeFileSync(outFile, html)
console.log(`wrote ${outFile}: ${total} items${dropped ? `, ${dropped} dropped (no source)` : ''}`)
