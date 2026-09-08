#!/usr/bin/env node
/**
 * Where the staged provider-page rollout has got to.
 *
 *   node scripts/connect-release-status.mjs            # today
 *   node scripts/connect-release-status.mjs 2026-10-01 # as of a date
 *
 * Run it before a deploy to see what that deploy will make public, and after a
 * wave opens to confirm it did.
 */
import { PROVIDERS } from '../src/lib/connect/providers.mjs';
import { releaseStatus, releasedProviders } from '../src/lib/connect/release.mjs';

const arg = process.argv[2];
const now = arg ? new Date(`${arg}T12:00:00.000Z`) : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`Not a date: ${arg}`);
  process.exit(1);
}

const status = releaseStatus(now);
const live = releasedProviders(now).length;

console.log(`\nProvider page rollout as of ${now.toISOString().slice(0, 10)}\n`);
let cumulative = 0;
for (const w of status) {
  cumulative += w.count;
  // Waves share dates now, so the wave number is a cohort label rather than a
  // position in a queue. Held waves have no date at all.
  const mark = w.held ? 'HELD  ' : w.released ? 'LIVE  ' : 'queued';
  const bar = '#'.repeat(w.count).padEnd(15, '.');
  console.log(
    `  wave ${String(w.wave).padStart(2)}  ${(w.date ?? 'no date').padEnd(10)}  ${mark}  ${bar}  ` +
    `${String(w.count).padStart(3)} pages  (${String(cumulative).padStart(3)} cumulative)`,
  );
}
console.log(`\n  public today : ${live} of ${PROVIDERS.length}`);
const next = status.find((w) => !w.released && !w.held);
const heldCount = status.filter((w) => w.held).reduce((sum, w) => sum + w.count, 0);
const dueNext = next ? status.filter((w) => w.date === next.date) : [];
console.log(next
  ? `  next wave    : ${dueNext.reduce((sum, w) => sum + w.count, 0)} pages on ${next.date}`
  : '  next wave    : none, everything scheduled is public');
console.log(heldCount
  ? `  held         : ${heldCount} pages, waiting on a human, not on a date\n`
  : '');

for (const w of status) {
  if (!w.released) {
    console.log(`  wave ${w.wave} (${w.held ? 'HELD for review' : w.date}): ${w.slugs.join(' ')}`);
  }
}
console.log('');
