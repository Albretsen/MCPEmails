#!/usr/bin/env node
// state-snapshot.mjs: gathers the facts for the twice-daily "state of the
// project" brief and writes them to state.json. No LLM here: the model that
// writes the brief only ranks and phrases what this script found, and every
// item carries its source (a PR URL or file:line).
//
// Collects:
//   - open PRs with CI state and age
//   - PRs merged since the previous run
//   - git worktrees with unmerged work and no open PR
//   - dated OWED / owed / pending / read-out / awaiting lines (and DONE: lines)
//     from the Claude memory folder and Documents/IDEAS.md
//   - what changed since the previous snapshot
//
// The output holds private notes, so it is written OUTSIDE the repo
// (default ~/.mcpemails-state/state.json). Never commit it.
//
// Usage: node scripts/state-snapshot.mjs [--out <file>] [--memory-dir <dir>]
//        [--ideas <file>] [--stdout]
// Needs: git, gh (authenticated). Run from any checkout or worktree of the repo.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const run = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()

const tryRun = (cmd, argv, opts) => {
  try {
    return run(cmd, argv, opts)
  } catch {
    return null
  }
}

// The main checkout is the parent of the shared .git dir, also from a worktree.
const commonDir = path.resolve(run('git', ['rev-parse', '--git-common-dir']))
const mainCheckout = path.dirname(commonDir)
const projectKey = mainCheckout.replace(/[/.]/g, '-')
const memoryDir = arg('--memory-dir') ?? path.join(os.homedir(), '.claude', 'projects', projectKey, 'memory')
const ideasFile = arg('--ideas') ?? path.join(mainCheckout, 'Documents', 'IDEAS.md')
const outFile = arg('--out') ?? path.join(os.homedir(), '.mcpemails-state', 'state.json')

const now = new Date()
const DAY = 86_400_000
const ageDays = (iso) => Math.floor((now - new Date(iso)) / DAY)
const isoDate = (d) => d.toISOString().slice(0, 10)

let previous = null
try {
  previous = JSON.parse(fs.readFileSync(outFile, 'utf8'))
} catch {}

const errors = []

// ---------- PRs ----------

function ciSummary(rollup) {
  const checks = (rollup ?? []).map((c) => ({
    name: c.name ?? c.context ?? 'check',
    // CheckRun has status + conclusion, StatusContext has state.
    state: (c.conclusion || c.state || c.status || '').toUpperCase(),
  }))
  const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c.state))
  const pending = checks.filter((c) => ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED', ''].includes(c.state))
  const gate = checks.find((c) => c.name === 'CI passed')
  return {
    state: failing.length ? 'failure' : pending.length ? 'pending' : checks.length ? 'success' : 'none',
    ci_passed_gate: gate ? gate.state.toLowerCase() : null,
    failing: failing.map((c) => c.name),
    pending: pending.map((c) => c.name),
    total: checks.length,
  }
}

let openPrs = []
try {
  const raw = JSON.parse(
    run('gh', [
      'pr', 'list', '--state', 'open', '--limit', '200',
      '--json', 'number,title,url,headRefName,isDraft,createdAt,updatedAt,author,reviewDecision,mergeable,statusCheckRollup,labels',
    ], { cwd: mainCheckout }),
  )
  openPrs = raw
    .map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.headRefName,
      draft: p.isDraft,
      author: p.author?.login ?? null,
      created_at: p.createdAt,
      updated_at: p.updatedAt,
      age_days: ageDays(p.createdAt),
      idle_days: ageDays(p.updatedAt),
      review_decision: p.reviewDecision || null,
      mergeable: p.mergeable,
      labels: (p.labels ?? []).map((l) => l.name),
      do_not_merge: /do not merge/i.test(p.title),
      ci: ciSummary(p.statusCheckRollup),
    }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
} catch (e) {
  errors.push(`gh pr list (open): ${e.message.split('\n')[0]}`)
}

const since = previous?.generated_at ?? new Date(now - DAY).toISOString()
let mergedSince = []
try {
  mergedSince = JSON.parse(
    run('gh', [
      'pr', 'list', '--state', 'merged', '--limit', '100',
      '--search', `merged:>=${since.slice(0, 19)}Z`,
      '--json', 'number,title,url,mergedAt,headRefName',
    ], { cwd: mainCheckout }),
  )
    .filter((p) => p.mergedAt >= since)
    .map((p) => ({ number: p.number, title: p.title, url: p.url, branch: p.headRefName, merged_at: p.mergedAt }))
    .sort((a, b) => a.merged_at.localeCompare(b.merged_at))
} catch (e) {
  errors.push(`gh pr list (merged): ${e.message.split('\n')[0]}`)
}

// Every PR by branch, to tell "never had a PR" from "PR merged or closed".
const prByBranch = new Map()
try {
  const all = JSON.parse(
    run('gh', ['pr', 'list', '--state', 'all', '--limit', '1000', '--json', 'number,state,headRefName,url'], { cwd: mainCheckout }),
  )
  // gh lists newest first; keep the newest PR per branch.
  for (const p of all) if (!prByBranch.has(p.headRefName)) prByBranch.set(p.headRefName, p)
} catch (e) {
  errors.push(`gh pr list (all): ${e.message.split('\n')[0]}`)
}

// ---------- worktrees ----------

const worktrees = []
const worktreeCounts = { total: 0, empty: 0, pr_open: 0, pr_merged_or_closed: 0, missing: 0 }
{
  tryRun('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: mainCheckout })
  const porcelain = run('git', ['worktree', 'list', '--porcelain'], { cwd: mainCheckout })
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n')
    const wtPath = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    if (!wtPath || wtPath === mainCheckout) continue
    worktreeCounts.total++
    if (!fs.existsSync(wtPath)) {
      worktreeCounts.missing++
      continue
    }
    const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '') ?? null
    const pr = branch ? prByBranch.get(branch) : undefined
    if (pr?.state === 'OPEN') {
      worktreeCounts.pr_open++
      continue
    }
    if (pr) {
      worktreeCounts.pr_merged_or_closed++
      continue
    }
    const ahead = Number(tryRun('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: wtPath }) ?? 0)
    const dirty = (tryRun('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: wtPath }) ?? '')
      .split('\n')
      .filter(Boolean).length
    if (!ahead && !dirty) {
      worktreeCounts.empty++
      continue
    }
    const last = tryRun('git', ['log', '-1', '--format=%cI%x09%s'], { cwd: wtPath })?.split('\t') ?? []
    worktrees.push({
      path: wtPath,
      branch,
      commits_ahead_of_main: ahead,
      uncommitted_files: dirty,
      last_commit_at: last[0] ?? null,
      last_commit_subject: last[1] ?? null,
      idle_days: last[0] ? ageDays(last[0]) : null,
    })
  }
  worktrees.sort((a, b) => (a.last_commit_at ?? '').localeCompare(b.last_commit_at ?? ''))
}

// ---------- owed lines ----------

const KEYWORD = /\b(OWED:|DONE:|owed|pending|read-?outs?|awaiting)/i
const DUE_HINT = /(due|read-?out|re-?read|re-?test|merges?|check|around|by|after|until|before|from|on|~)\s*:?\s*~?$/i
const FULL_DATE = /\b(20\d\d)-(\d\d)-(\d\d)\b/g
const SHORT_DATE = /(?<![\d#v.\-/:])(~?)(\d{1,2})-(\d{2})(?![\d\-%])/g

function fileDate(name, fullPath) {
  const m = name.match(/(20\d\d)(\d\d)(\d\d)/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return new Date(fs.statSync(fullPath).mtime)
}

function datesIn(line, asOf) {
  const out = []
  for (const m of line.matchAll(FULL_DATE)) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    if (!isNaN(d)) out.push({ date: isoDate(d), index: m.index })
  }
  for (const m of line.matchAll(SHORT_DATE)) {
    const mo = +m[2]
    const da = +m[3]
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue
    let d = new Date(Date.UTC(asOf.getUTCFullYear(), mo - 1, da))
    // "01-05" written in a 2026-12 note means next January.
    if (d < asOf - 120 * DAY) d = new Date(Date.UTC(asOf.getUTCFullYear() + 1, mo - 1, da))
    out.push({ date: isoDate(d), index: m.index })
  }
  return out.sort((a, b) => a.index - b.index)
}

function dueDate(line, dates) {
  const explicit = line.match(/\(due (20\d\d-\d\d-\d\d)\)/i)
  if (explicit) return explicit[1]
  for (const d of dates) {
    if (DUE_HINT.test(line.slice(Math.max(0, d.index - 12), d.index))) return d.date
  }
  return null
}

function excerpt(line, at) {
  const clean = line.replace(/\s+/g, ' ').trim()
  if (clean.length <= 260) return clean
  const start = Math.max(0, Math.min(at - 100, clean.length - 260))
  return (start ? '...' : '') + clean.slice(start, start + 260) + (start + 260 < clean.length ? '...' : '')
}

const owed = []
const done = []
const sources = []
try {
  for (const f of fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md')).sort()) sources.push(path.join(memoryDir, f))
} catch (e) {
  errors.push(`memory dir: ${e.message}`)
}
if (fs.existsSync(ideasFile)) sources.push(ideasFile)
else errors.push(`ideas file not found: ${ideasFile}`)

for (const file of sources) {
  const name = path.basename(file)
  const asOf = fileDate(name, file)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let inFrontmatter = false
  lines.forEach((line, i) => {
    if (i === 0 && line === '---') inFrontmatter = true
    else if (inFrontmatter && line === '---') inFrontmatter = false
    if (inFrontmatter && !line.startsWith('description:')) return
    const k = line.match(KEYWORD)
    if (!k) return
    const dates = datesIn(line, asOf)
    const isDone = k[1] === 'DONE:'
    const isOwedTag = k[1] === 'OWED:'
    if (!dates.length && !isOwedTag && !isDone) return // only dated lines
    const shortSource = file.startsWith(memoryDir) ? `memory/${name}` : file.replace(mainCheckout + '/', '')
    const item = {
      source: `${shortSource}:${i + 1}`,
      path: file,
      line: i + 1,
      kind: k[1].toLowerCase().replace(/:$/, '').replace(/^readouts?$|^read-outs$/, 'read-out'),
      text: excerpt(line, k.index),
      note_date: isoDate(asOf),
      dates: [...new Set(dates.map((d) => d.date))],
      due: dueDate(line, dates),
    }
    if (isDone) done.push(item)
    else owed.push(item)
  })
}
owed.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.note_date.localeCompare(b.note_date))

// ---------- changes since the previous snapshot ----------

const prevOpen = new Map((previous?.open_prs ?? []).map((p) => [p.number, p]))
const curOpen = new Map(openPrs.map((p) => [p.number, p]))
const prevOwed = new Set((previous?.owed ?? []).map((o) => `${o.path}::${o.text}`))
const curOwed = new Set(owed.map((o) => `${o.path}::${o.text}`))
const changes = previous
  ? {
      previous_generated_at: previous.generated_at,
      prs_opened: openPrs.filter((p) => !prevOpen.has(p.number)).map((p) => ({ number: p.number, url: p.url, title: p.title })),
      prs_left_open: [...prevOpen.values()].filter((p) => !curOpen.has(p.number)).map((p) => ({ number: p.number, url: p.url, title: p.title })),
      ci_changed: openPrs
        .filter((p) => prevOpen.has(p.number) && prevOpen.get(p.number).ci.state !== p.ci.state)
        .map((p) => ({ number: p.number, url: p.url, from: prevOpen.get(p.number).ci.state, to: p.ci.state })),
      owed_added: owed.filter((o) => !prevOwed.has(`${o.path}::${o.text}`)).map((o) => ({ source: o.source, text: o.text })),
      owed_removed: (previous.owed ?? []).filter((o) => !curOwed.has(`${o.path}::${o.text}`)).map((o) => ({ source: o.source, text: o.text })),
    }
  : null

const state = {
  generated_at: now.toISOString(),
  since,
  repo: tryRun('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: mainCheckout }),
  main_checkout: mainCheckout,
  sources: { memory_dir: memoryDir, ideas_file: ideasFile },
  open_prs: openPrs,
  merged_since_last_run: mergedSince,
  worktrees_without_pr: worktrees,
  worktree_counts: worktreeCounts,
  owed,
  done,
  changes,
  errors,
}

const json = JSON.stringify(state, null, 2)
if (args.includes('--stdout')) process.stdout.write(json + '\n')
else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  if (previous) fs.writeFileSync(outFile.replace(/\.json$/, '.prev.json'), JSON.stringify(previous, null, 2))
  fs.writeFileSync(outFile, json + '\n')
  console.log(
    `wrote ${outFile}: ${openPrs.length} open PRs, ${mergedSince.length} merged since ${since}, ` +
      `${worktrees.length} worktrees without PR, ${owed.length} owed, ${done.length} done` +
      (errors.length ? `, ${errors.length} errors` : ''),
  )
}
