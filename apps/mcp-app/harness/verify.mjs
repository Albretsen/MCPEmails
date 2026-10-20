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
//
// IN PARALLEL (2026-10-20). Run one after another the suites took ~144 s of
// the card job, almost all of it esbuild bundling and jsdom start-up, on a
// four-CPU runner. They now run CARD_TEST_CONCURRENCY at a time (default 4;
// 1 is the old serial run). Each suite still bundles to its own
// dist/<name>.bundle.mjs and owns its own fake host, so nothing is shared.
// Output is buffered per suite and printed whole, in the order below, so the
// log reads exactly as it did serially.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const concurrency = Math.max(1, Number.parseInt(process.env.CARD_TEST_CONCURRENCY ?? "", 10) || 4);

const SUITES = [
  ["state machine", "state-machine.mjs"],
  ["hardening", "hardening.mjs"],
  ["storage audit", "storage-audit.mjs"],
  ["draft body", "draft-body.test.mjs"],
  // The only suite that needs a DOM: it mounts the real DraftEditor in jsdom,
  // because the two defects it pins (a resync that discards unsaved typing, and
  // a teardown that lands between a new envelope and the effect which would
  // disarm the saver) are properties of a mounted component and are invisible
  // to a pure function. jsdom is resolved up out of the root node_modules as a
  // direct dependency of the apps/web workspace, the same hoisting arrangement
  // esbuild already relies on — see the note above the `card` job in
  // .github/workflows/ci.yml.
  ["draft resync", "draft-sync.test.mjs"],
  // The second DOM suite, and the second one that could not have been written
  // without one: it evaluates the REAL `main.tsx` into jsdom and asks what is
  // on screen in each of the states where there is no draft to draw. Every
  // defect it pins — a blank frame while loading, a card that never appears —
  // is a property of the rendered tree and of main.tsx's own composition
  // order, and is invisible to a suite that only reads the store.
  ["card render", "card-render.test.mjs"],
  // The third DOM suite: the draft card QA blockers of 2026-10-13, played
  // through the real `main.tsx` against a scripted host that answers the
  // card's own `tools/call` requests — failed and lost actions, a remounted
  // card's replayed result, unsaved edits across a reload, focus around the
  // confirms, and recipients that are not addresses yet.
  ["draft QA", "draft-qa.test.mjs"],
  // The fourth DOM suite: the QA report's smaller issues (recipients, focus,
  // fullscreen, copy, the formatted preview) and the card's reading of the
  // server's new draft fields — formatting_removed, signature.rich,
  // resolved_from, a null last_saved_at — including the replay check against a
  // model's fresh draft_read of an old draft (one verifying read, no loop).
  ["draft polish", "draft-polish.test.mjs"],
  // The fifth DOM suite: the state bugs of the second QA pass (2026-10-13).
  // Which copy "Use the newer version" loads, one notice at a time, Send
  // following the recipients on screen, a draft that is already gone, an older
  // card folding to one line, leaving fullscreen when a card ends, and what a
  // reopened chat shows for a discarded or a saved draft.
  ["draft state", "draft-state.test.mjs"],
  // The sixth DOM suite: the second QA pass's smaller issues. Addresses a
  // space apart, a dropped display name and a duplicate both said out loud,
  // the two-press Backspace, chips on the arrow keys, Cancel in the signature
  // box, "Copied" and "Up to date" that revert, and the fullscreen action row
  // as a row of its own rather than an overlay.
  ["draft UX", "draft-ux.test.mjs"],
  // The seventh DOM suite: "Show" on the line a sent or discarded draft card
  // ends on. What it reveals in each ending, after the chat is reopened with
  // and without a stored copy, that it is never the assistant's original text
  // when the person's edits went out, and where that copy is (and is not) kept.
  ["draft ended", "draft-ended.test.mjs"],
  // The eighth DOM suite: the send-safety QA report of 2026-10-15. A footer
  // that never moves under the pointer, Send's undo window (nothing is called
  // before it runs out; Undo, a double-click, an edit, unmount and teardown all
  // cancel), Enter on a recipient that is not an address, and an older card
  // that folds when a newer one mounts, without being touched.
  ["draft send safety", "draft-send-safety.test.mjs"],
  // The ninth DOM suite: a formatted draft (heading, list, link) under the
  // plain-text box (QA, 2026-10-17). The warning before a save that would turn
  // it into plain text and its undo, the notice after one, and focus kept in
  // the frame when switching between the formatted view and the box.
  ["draft formatting", "draft-formatting.test.mjs"],
  // The tenth DOM suite: a reply's quoted original (release review,
  // 2026-10-17). The Signature row is the signature, the quote is a read-only
  // section of its own, and every save hands the quote back byte for byte.
  ["draft quote", "draft-quote.test.mjs"],
  // The eleventh DOM suite: the layout review of 2026-10-17 in claude.ai. Nothing
  // moves under the pointer (header status, the ⋯ overlay, the delete confirm
  // on the left), one status said one way, Send off during a save, "Delete
  // draft" vs "Undo my edits", the empty-subject question, narrow widths.
  // footer-geometry.mjs measures the same promises in real Chrome.
  ["draft layout", "draft-layout.test.mjs"],
  // The twelfth DOM suite: the recipient fields and files of the 2026-10-17
  // live review. Rows and chips that stay put under the pointer, duplicates
  // across fields, separators and pasted lists, suggestions (and the server
  // adapter that is not wired), and files as chips that can be removed and
  // attached.
  ["draft fields", "draft-fields.test.mjs"],
  // DOM-free, and last only because it was merged last: the exact text of every
  // sentence the card sends the model, and the decisions behind a deferred
  // draft body (where it comes from, and which `draft_read` answer is adopted).
  ["model context", "model-context.test.mjs"],
  // DOM-free: the layer-1 deny-list in src/sanitize.ts against its old regex
  // chain (kept verbatim as an oracle), plus 512 KB timing on hostile shapes.
  ["sanitize layer 1", "sanitize.test.mjs"],
];

function runSuite([label, file]) {
  return new Promise((done) => {
    const chunks = [];
    const child = spawn(process.execPath, [resolve(here, file)], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    let error = null;
    child.on("error", (err) => {
      error = err;
    });
    child.on("close", (status, signal) => {
      // Three distinct endings, and they are not the same finding: a clean
      // pass, a suite that ran and failed checks, and a suite that never got
      // to say anything. The third is the one `&&` used to turn into silence.
      const outcome =
        error || signal
          ? { label, state: "crashed", detail: String(error?.message ?? signal) }
          : status === 0
            ? { label, state: "passed", detail: "" }
            : { label, state: "failed", detail: `exit ${status}` };
      done({ ...outcome, output: Buffer.concat(chunks) });
    });
  });
}

const outcomes = new Array(SUITES.length);
let printed = 0;
function flush() {
  while (printed < SUITES.length && outcomes[printed]) {
    const o = outcomes[printed++];
    console.log(`\n──── ${o.label} ${"─".repeat(Math.max(0, 60 - o.label.length))}`);
    process.stdout.write(o.output);
  }
}

let next = 0;
async function worker() {
  while (next < SUITES.length) {
    const i = next++;
    outcomes[i] = await runSuite(SUITES[i]);
    flush();
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, SUITES.length) }, worker));

console.log(`\n──── verify ${"─".repeat(56)}`);
for (const o of outcomes) {
  const mark = o.state === "passed" ? "ok  " : "FAIL";
  console.log(`${mark}  ${o.label}${o.detail ? `  (${o.detail})` : ""}`);
}

const bad = outcomes.filter((o) => o.state !== "passed");
console.log(`${outcomes.length - bad.length}/${outcomes.length} suites passed`);
// exitCode, not exit(): a pipe may still be draining the buffered output.
process.exitCode = bad.length ? 1 : 0;
