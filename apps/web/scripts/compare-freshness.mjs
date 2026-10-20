#!/usr/bin/env node
/**
 * Which comparison-page sources have not been re-read recently?
 *
 * The comparison pages (/best-email-mcp-servers, /native-connectors-vs-mcp)
 * make dated claims about other companies. Every claim's source carries the
 * ISO date it was last read (`checkedOn`). This script lists the sources older
 * than MAX_AGE_DAYS (default 45) so someone re-reads them and moves the date.
 *
 * Deliberately NOT a CI test. `CI passed` gates every production deploy, and a
 * check that fails because the calendar moved would block unrelated deploys on
 * a day nobody touched these pages. The weekly workflow
 * .github/workflows/compare-freshness.yml runs this instead and opens (or
 * updates) a GitHub issue. The structural rules (every source dated, no tool
 * counts) are unit tests that do run in CI.
 *
 *   node scripts/compare-freshness.mjs            # markdown report, exit 1 if stale
 *   MAX_AGE_DAYS=30 node scripts/compare-freshness.mjs
 */
import * as Best from '../src/lib/compare/email-mcp-servers.mjs';
import * as Native from '../src/lib/compare/native-connectors.mjs';

const DAY = 24 * 60 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Every dated source, as { page, label, url, checkedOn }. A missing date is kept as null. */
export function collectSources(best = Best, native = Native) {
  const bestItems = Array.isArray(best.SOURCES) ? best.SOURCES : best.SOURCES?.items ?? [];
  return [
    ...bestItems.map((s) => ({ page: best.PATH, label: s.label, url: s.url, checkedOn: s.checkedOn ?? null })),
    ...native.SOURCES.map((s) => ({ page: native.PATH, label: s.id, url: s.url, checkedOn: s.checkedOn ?? null })),
  ];
}

/** Sources older than maxAgeDays on `today` (an ISO date), or with no valid date, oldest first. */
export function staleSources(sources, today, maxAgeDays) {
  const now = Date.parse(`${today}T00:00:00Z`);
  return sources
    .map((s) => ({
      ...s,
      ageDays: s.checkedOn && ISO.test(s.checkedOn) ? Math.floor((now - Date.parse(`${s.checkedOn}T00:00:00Z`)) / DAY) : null,
    }))
    .filter((s) => s.ageDays === null || s.ageDays > maxAgeDays)
    .sort((a, b) => (b.ageDays ?? Infinity) - (a.ageDays ?? Infinity));
}

export function report(stale, today, maxAgeDays) {
  if (stale.length === 0) return `Every comparison-page source was read within ${maxAgeDays} days of ${today}.`;
  const rows = stale.map((s) => `| ${s.page} | ${s.label} | ${s.url} | ${s.checkedOn ?? 'no date'} | ${s.ageDays ?? 'n/a'} |`);
  return [
    `${stale.length} comparison-page source(s) were last read more than ${maxAgeDays} days before ${today}, or carry no date.`,
    '',
    'Re-read each one live, correct any claim that changed, and move its `checkedOn` (and the page\'s DATE_MODIFIED) in',
    '`apps/web/src/lib/compare/email-mcp-servers.mjs` or `apps/web/src/lib/compare/native-connectors.mjs`.',
    'Read the rules at the top of each file first.',
    '',
    '| Page | Source | URL | Last read | Days |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const maxAgeDays = Number(process.env.MAX_AGE_DAYS ?? 45);
  const today = new Date().toISOString().slice(0, 10);
  const stale = staleSources(collectSources(), today, maxAgeDays);
  console.log(report(stale, today, maxAgeDays));
  process.exitCode = stale.length > 0 ? 1 : 0;
}
