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
// WHY A POOL (2026-10-20). Run one after another, ~105 suites took ~145 s of
// the Unit Tests job, most of it Node start-up and module loading rather than
// test work, with three of the runner's four CPUs idle. Suites now run
// TEST_CONCURRENCY at a time (default 4, the CI runner's CPU count;
// TEST_CONCURRENCY=1 is the old serial run). Each suite's output is buffered
// and printed whole, in package.json order, so a log reads exactly as before.
// Suites are independent processes; none shares a port or a fixed temp path.
//
// WHY NOT `npm run`. A plain `node ...` script is spawned directly with the
// same arguments in the same cwd, which skips one npm start-up per suite. A
// script with anything a shell would interpret falls back to `npm run`.
//
// Output ends with "N/N suites passed". If that number ever drops, a suite was
// removed, not fixed.
// ---------------------------------------------------------------------------

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { scripts } = JSON.parse(readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
const suites = Object.keys(scripts).filter((name) => name.startsWith('test:'));
const inCi = process.env.GITHUB_ACTIONS === 'true';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const concurrency = Math.max(1, Number.parseInt(process.env.TEST_CONCURRENCY ?? '', 10) || 4);

/** `node <args>` with nothing for a shell to expand runs directly; else npm. */
function commandFor(name) {
  const script = scripts[name].trim();
  if (/^node\s/.test(script) && !/[|&;<>()$`"'\\*?{}~\n]/.test(script)) {
    return [process.execPath, script.split(/\s+/).slice(1)];
  }
  return [npm, ['run', '--silent', name]];
}

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const [cmd, args] = commandFor(name);
    const chunks = [];
    const child = spawn(cmd, args, { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    let spawnError = null;
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code, signal) => {
      if (spawnError) chunks.push(Buffer.from(`\n${name}: failed to start: ${spawnError.message}\n`));
      resolve({
        name,
        ok: !spawnError && code === 0,
        exit: spawnError ? 'spawn error' : (code ?? signal),
        seconds: (Date.now() - started) / 1000,
        output: Buffer.concat(chunks),
      });
    });
  });
}

const results = new Array(suites.length);
const done = new Array(suites.length).fill(false);
let printed = 0;
function flush() {
  while (printed < suites.length && done[printed]) {
    const r = results[printed++];
    if (inCi) console.log(`::group::${r.name}`);
    else console.log(`\n=== ${r.name} ===`);
    process.stdout.write(r.output);
    if (inCi) console.log('::endgroup::');
    if (!r.ok && inCi) console.log(`::error title=${r.name} failed::npm run ${r.name} exited ${r.exit}`);
  }
}

const wallStart = Date.now();
let next = 0;
async function worker() {
  while (next < suites.length) {
    const i = next++;
    results[i] = await runSuite(suites[i]);
    done[i] = true;
    flush();
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, suites.length) }, worker));

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
console.log(`\nwall ${((Date.now() - wallStart) / 1000).toFixed(1)}s at concurrency ${concurrency}`);
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} suites passed${orphans.length ? `, ${orphans.length} orphaned test file(s)` : ''}`);

// exitCode, not exit(): a pipe may still be draining the buffered output.
process.exitCode = passed === results.length && orphans.length === 0 ? 0 : 1;
