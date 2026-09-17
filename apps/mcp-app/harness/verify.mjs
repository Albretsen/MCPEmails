#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Runs every harness in apps/mcp-app and reports all of them.
//
//   node harness/verify.mjs      (or: npm run verify -w apps/mcp-app)
//
// WHY THIS FILE EXISTS. `verify` used to be
//
//     node harness/state-machine.mjs && node harness/hardening.mjs && node harness/storage-audit.mjs && node harness/draft-body.test.mjs
//
// and `&&` is not "run the suites", it is "run suites until one of them is
// unhappy". That is a reasonable default for a build step and a bad one for a
// verification pass, because the suites are INDEPENDENT: nothing the storage
// audit checks depends on the state machine passing, and the two later suites
// are exactly the ones that ask the questions the first one cannot.
//
// It is not hypothetical. The round-3 verification pass traced defect D1 — an
// undocumented change to the storage key's separator — to precisely this: a
// crash inside state-machine.mjs meant storage-audit.mjs never ran, and the
// storage audit is the suite that would have named the change. One suite being
// broken concealed the only thing that could have found the other problem.
//
// So: every suite runs, every suite's own output is passed straight through
// (stdio: "inherit", so the per-check lines and the counts below them are
// unchanged), and the exit code is the OR of all of them. A suite that crashes
// outright is reported as a crash and does not stop the next one — the crash is
// itself a finding, and it is now a finding you get to read alongside the
// others rather than instead of them.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * In order, because the later ones are cheaper to read once the earlier ones
 * have printed. The order carries no dependency: each one builds its own
 * esbuild bundle from src/ and owns its own fake host.
 */
const SUITES = [
  ["state machine", "state-machine.mjs"],
  ["hardening", "hardening.mjs"],
  ["storage audit", "storage-audit.mjs"],
  ["draft body", "draft-body.test.mjs"],
];

const outcomes = [];

for (const [label, file] of SUITES) {
  console.log(`\n──── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  const run = spawnSync(process.execPath, [resolve(here, file)], {
    stdio: "inherit",
  });
  // Three distinct endings, and they are not the same finding: a clean pass, a
  // suite that ran and failed checks, and a suite that never got to say
  // anything. The third is the one `&&` used to turn into silence.
  const outcome =
    run.error || run.signal
      ? { label, state: "crashed", detail: String(run.error?.message ?? run.signal) }
      : run.status === 0
        ? { label, state: "passed", detail: "" }
        : { label, state: "failed", detail: `exit ${run.status}` };
  outcomes.push(outcome);
}

console.log(`\n──── verify ${"─".repeat(56)}`);
for (const o of outcomes) {
  const mark = o.state === "passed" ? "ok  " : "FAIL";
  console.log(`${mark}  ${o.label}${o.detail ? `  (${o.detail})` : ""}`);
}

const bad = outcomes.filter((o) => o.state !== "passed");
console.log(`${outcomes.length - bad.length}/${outcomes.length} suites passed`);
process.exit(bad.length ? 1 : 0);
