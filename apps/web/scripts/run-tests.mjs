#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm test`: run EVERY `test:*` script in package.json, then report all of
// them.
//
// WHY THIS REPLACED THE `&&` CHAIN (2026-09-26). `npm test` used to be 46
// `npm run test:x && ...` links, so the first failure stopped the rest. On the
// red run of 1ae4dbb, test:automations-ui was link 21: the other 25 suites never
// ran, and nobody could say whether anything else was broken. Same lesson as
// apps/mcp-app/harness/verify.mjs, which exists for the same reason.
//
// WHY THE SUITE LIST IS READ FROM package.json. A hand-kept list drifts: the
// old chain had to be edited in step with every new `test:*` script. Here, a
// script named `test:<anything>` IS a suite. The per-suite flags
// (--experimental-strip-types, the alias and DOM loaders) stay where they are.
//
// WHY THE ORPHAN CHECK. A `*.test.*` file that no `test:*` script names never
// runs, and it passes silently forever. src/lib/onboarding/state.test.ts sat
// like that from 2026-08-10 to 2026-09-26. Any tracked test file that no script
// names now fails the run.
//
// Output ends with "N/N suites passed". If that number ever drops, a suite was
// removed, not fixed.
// ---------------------------------------------------------------------------

import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { scripts } = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
const suites = Object.keys(scripts).filter((name) => name.startsWith('test:'));
const inCi = process.env.GITHUB_ACTIONS === 'true';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const results = [];
for (const name of suites) {
  const started = Date.now();
  if (inCi) console.log(`::group::${name}`);
  else console.log(`\n=== ${name} ===`);
  const run = spawnSync(npm, ['run', '--silent', name], { cwd: webRoot, stdio: 'inherit' });
  if (inCi) console.log('::endgroup::');
  const ok = run.status === 0;
  results.push({ name, ok, seconds: (Date.now() - started) / 1000 });
  if (!ok && inCi) console.log(`::error title=${name} failed::npm run ${name} exited ${run.status ?? run.signal}`);
}

const named = suites.map((name) => scripts[name]).join(' ');
const testFiles = execFileSync('git', ['ls-files', '--', '*.test.js', '*.test.mjs', '*.test.ts', '*.test.tsx', '*.test.jsx'], {
  cwd: webRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const orphans = testFiles.filter((file) => !named.includes(file));

console.log('\n--- summary ---');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.seconds.toFixed(1)}s)`);
for (const file of orphans) {
  console.log(`ORPHAN  ${file}  (no test:* script runs it)`);
  if (inCi) console.log(`::error file=apps/web/${file},title=Test file never runs::Add it to a test:* script in apps/web/package.json`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} suites passed${orphans.length ? `, ${orphans.length} orphaned test file(s)` : ''}`);

process.exit(passed === results.length && orphans.length === 0 ? 0 : 1);
