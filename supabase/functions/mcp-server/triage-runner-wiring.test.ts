// ---------------------------------------------------------------------------
// How index.ts wires the automation runner to a provider.
//
// ── What went wrong ────────────────────────────────────────────────────────
// 2026-09-16. One AOL mailbox (five simultaneous connections, provider-capped)
// ran 49 move rules on a fifteen minute cadence. Over one day it produced:
//
//   * ~4400 IMAP handshakes, because every single message opened, authenticated
//     and tore down its own connection, and another ~4400 single-row selects of
//     the same inbox row to go with them;
//   * 50 `folder_not_found` rows on `triage_move`, while the same rules moved
//     4380 messages into the same four folders the same day. The provider was
//     answering `[TRYCREATE]` under the connection pressure we were generating,
//     and the log reported it as the customer's folder being gone;
//   * 51 runs killed mid-message and swept up as `run_interrupted`, which is
//     deliberately never retried.
//
// ── Why this is a source scan ──────────────────────────────────────────────
// index.ts calls `Deno.serve` at module load and exports nothing, so a test
// cannot import a handler and run it. Same standing constraint, and the same
// split, as search-phase-wiring.test.ts: the BEHAVIOUR lives in
// triage-engine.test.ts against the real engine with injected seams, and this
// file pins that index.ts hands that engine the pieces it is designed around.
// Neither half is worth much alone.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const INDEX_SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/** The body of a top-level `async function`, up to its closing brace. */
function functionSource(name: string): string {
  const start = INDEX_SOURCE.indexOf(`async function ${name}(`);
  assert(start >= 0, `${name} not found in index.ts`);
  const end = INDEX_SOURCE.indexOf("\n}\n", start);
  assert(end > start, `${name} has no closing brace in index.ts`);
  return INDEX_SOURCE.slice(start, end);
}

/** The body of the `triageDeps()` factory, which is where the seams are wired. */
function triageDepsSource(): string {
  const start = INDEX_SOURCE.indexOf("function triageDeps(): TriageDeps {");
  assert(start >= 0, "triageDeps() not found in index.ts");
  const end = INDEX_SOURCE.indexOf("\n}\n", start);
  assert(end > start, "triageDeps() has no closing brace");
  return INDEX_SOURCE.slice(start, end);
}

// ---------------------------------------------------------------------------
// One connection, and one inbox row, per run
// ---------------------------------------------------------------------------

Deno.test("the runner opens a real IMAP session per run and closes it", () => {
  const deps = triageDepsSource();
  assertStringIncludes(
    deps,
    "imap: imapSessionFor(inboxRow)",
    "openSession must hand back a real session for IMAP inboxes",
  );
  assertStringIncludes(
    deps,
    "if (run?.imap) await run.imap.close();",
    "closeSession must actually close it",
  );
});

Deno.test("every bulk action borrows the run's connection instead of opening one", () => {
  // BulkRunOptions.session has existed since 2026-09-01 and its own comment
  // named the triage runner as the caller that did NOT use it. That is the
  // whole of this fix.
  const body = functionSource("applyTriageAction");
  for (const helper of ["runBulkMoveOnIds", "runBulkFlagOnIds"]) {
    const at = body.indexOf(helper);
    assert(at > 0, `${helper} is no longer called from applyTriageAction`);
    const call = body.slice(at, at + 260);
    assertStringIncludes(
      call,
      "session: imapSession",
      `${helper} must be handed the run's connection`,
    );
  }
});

Deno.test("the inbox row is read once per run, not once per message", () => {
  // 200 identical single-row selects on top of 200 handshakes, for a row that
  // cannot change mid-run. Every interactive tool call already reads it once.
  const body = functionSource("applyTriageAction");
  assertStringIncludes(
    body,
    "run?.inboxRow ?? await loadInboxRowForTriage(input.inbox.id)",
    "the cached row must be preferred, with the per-message read left as the fallback",
  );
});

Deno.test("the shared connection is null-safe everywhere it is used", () => {
  // openSession is optional on TriageDeps and is allowed to fail; every
  // consumer must degrade to connect-per-action rather than to a broken run.
  const body = functionSource("applyTriageAction");
  assertStringIncludes(
    body,
    "const run = input.session as TriageRunSession | null;",
    "the opaque session is cast exactly once",
  );
  assertStringIncludes(
    body,
    "run?.imap ?? undefined",
    "an absent connection must read as 'open your own', not as a null client",
  );
});

// ---------------------------------------------------------------------------
// A destination the provider vouched for
// ---------------------------------------------------------------------------

Deno.test("the move destination is resolved strictly first, so 'verified' means something", () => {
  const deps = triageDepsSource();
  assertStringIncludes(
    deps,
    "{ strict: true, session: imap }",
    "the first resolve must be the one that only answers from the provider's listing",
  );
  assertStringIncludes(deps, "verified: true", "and a strict hit is what verified means");
});

Deno.test("only a missing folder falls back to the pass-through, and it is marked unverified", () => {
  const deps = triageDepsSource();
  assertStringIncludes(
    deps,
    'error.logErrorCode !== "folder_not_found"',
    "an ambiguous spelling is a question no mode can answer and must re-throw",
  );
  assertStringIncludes(
    deps,
    "verified: false",
    "a pass-through is not evidence the folder exists",
  );
  const strictAt = deps.indexOf("strict: true");
  const fallbackAt = deps.indexOf("verified: false");
  assert(
    strictAt > 0 && fallbackAt > strictAt,
    "strict must be tried BEFORE the pass-through, or verified is always false",
  );
});

Deno.test("the fallback re-uses resolveFolderId rather than reimplementing it", () => {
  // The default mode does more than skip the throw: it resolves aliases against
  // SPECIAL-USE flags and auto-creates a missing archive mailbox for a move.
  // A hand-rolled substitute would silently drop both.
  const deps = triageDepsSource();
  assertStringIncludes(
    deps,
    "await resolveFolderId(inboxRow, nameOrId, { session: imap })",
    "the unverified branch must call the real resolver with no strict flag",
  );
});
