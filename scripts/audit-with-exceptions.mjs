#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm audit --audit-level=high`, with dated exceptions.
//
// WHY THIS EXISTS. The Dependency Audit job fails the build on any high or
// critical advisory anywhere in the lockfile, dev tooling included, on
// purpose (see the note on the job in .github/workflows/ci.yml). That rule has
// one hole: an advisory with NO patched release cannot be fixed by anything we
// do, and while it stands it holds every production deploy behind the
// "CI passed" gate. `npm audit` has no way to skip one advisory, and
// `--omit=dev` would hide a whole class of findings to get past one.
//
// So an exception here names ONE advisory, says why it is tolerable, and
// carries a date. Until that date the advisory does not fail the job (it is
// still printed). From that date on it fails again, by itself, so an exception
// cannot outlive the attention it was granted with. Everything else, in
// production and dev dependencies alike, fails exactly as before.
//
// RULES FOR ADDING ONE.
//   1. Only when no patched release exists, or the only fix is a breaking
//      upgrade that is scheduled. Never to get a build through.
//   2. `expires` is at most about a month out. Renewing means re-reading the
//      advisory and editing the date, which is the point.
//   3. `reason` says how the package reaches us and why that is tolerable.
//   4. Delete the entry the day a patched release lands and `npm audit fix`
//      clears it.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** @type {{ id: string, expires: string, reason: string }[]} */
export const EXCEPTIONS = [
  {
    // braces: stack exhaustion on deeply nested patterns. Affects <=3.0.3 and
    // 3.0.3 is the newest release, so there is nothing to upgrade to.
    id: 'GHSA-vfj7-8cjw-p6xm',
    expires: '2026-11-03',
    reason:
      'No patched braces release exists. It reaches the tree only through build tooling ' +
      '(eslint-config-next and vite-plugin-singlefile, via micromatch), which globs our own ' +
      'file patterns and never sees outside input. `npm audit --omit=dev` is clean.',
  },
];

const FAILING = new Set(['high', 'critical']);

/** The GHSA id at the end of an advisory URL, or null. */
export function advisoryId(url) {
  const match = typeof url === 'string' ? url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i) : null;
  return match ? match[0] : null;
}

/**
 * Every high or critical ADVISORY in an `npm audit --json` report.
 *
 * The report lists vulnerable packages; each one's `via` holds either advisory
 * objects (the package itself is affected) or package names (it merely depends
 * on an affected one). The advisory objects across all packages are therefore
 * the complete set of causes, and the name entries add nothing to it.
 */
export function failingAdvisories(report) {
  const found = new Map();
  for (const [name, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of entry?.via ?? []) {
      if (!via || typeof via !== 'object') continue;
      if (!FAILING.has(via.severity)) continue;
      // An advisory we cannot identify can never be excepted.
      const id = advisoryId(via.url) ?? `unidentified:${name}:${via.source ?? via.title ?? '?'}`;
      if (!found.has(id)) found.set(id, { id, severity: via.severity, package: via.name ?? name, url: via.url ?? null });
    }
  }
  return [...found.values()];
}

/**
 * Split the failing advisories into the ones an unexpired exception covers and
 * the ones that fail the job. `today` is a YYYY-MM-DD string; an exception
 * stops applying ON its expiry date.
 */
export function judge(report, exceptions, today) {
  const live = new Map();
  const expired = [];
  for (const exception of exceptions) {
    if (typeof exception.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(exception.expires) && today < exception.expires) {
      live.set(exception.id.toUpperCase(), exception);
    } else {
      expired.push(exception);
    }
  }
  const excepted = [];
  const failing = [];
  for (const advisory of failingAdvisories(report)) {
    const exception = live.get(advisory.id.toUpperCase());
    if (exception) excepted.push({ ...advisory, expires: exception.expires });
    else failing.push(advisory);
  }
  // The report says vulnerabilities exist but names no advisory we could read:
  // fail rather than pass on a shape we do not understand.
  const counted = report?.metadata?.vulnerabilities ?? {};
  const reported = (counted.high ?? 0) + (counted.critical ?? 0);
  const unreadable = reported > 0 && excepted.length + failing.length === 0;
  return { excepted, failing, expired, unreadable };
}

function main() {
  const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error('npm audit did not return JSON. Failing: an audit that cannot be read is not a pass.');
    console.error(run.stderr || run.stdout);
    process.exit(1);
  }
  if (report?.error) {
    console.error('npm audit reported an error:', JSON.stringify(report.error));
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const { excepted, failing, expired, unreadable } = judge(report, EXCEPTIONS, today);

  for (const advisory of excepted) {
    console.log(`EXCEPTED until ${advisory.expires}: ${advisory.id} (${advisory.severity}, ${advisory.package}) ${advisory.url ?? ''}`);
  }
  for (const exception of expired) {
    console.log(`Exception for ${exception.id} expired on ${exception.expires} and no longer applies.`);
  }
  if (unreadable) {
    console.error('npm audit counts high or critical vulnerabilities but lists no advisory this script can read. Failing.');
    process.exit(1);
  }
  if (failing.length > 0) {
    console.error(`\n${failing.length} high or critical advisory(ies) with no live exception:`);
    for (const advisory of failing) {
      console.error(`  ${advisory.id} (${advisory.severity}, ${advisory.package}) ${advisory.url ?? ''}`);
    }
    console.error('\nRun `npm audit` for the full report and `npm audit fix` for the fix.');
    process.exit(1);
  }
  console.log(excepted.length > 0
    ? 'No high or critical advisories outside the dated exceptions above.'
    : 'No high or critical advisories.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
