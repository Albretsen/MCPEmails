// ---------------------------------------------------------------------------
// The text a plugin reviewer actually reads.
//
// `tool-surface.test.ts` pins the three BOOLEANS in each heading of
// docs/openai-tool-annotation-justifications.md against what the registry
// publishes. It pins nothing about the sentences submitted underneath them,
// which is the half v1.0.0 was rejected on: "one or more of the tool's
// annotations do not appear to match the tool's behaviour ... include a clear
// justification for why the hint is set".
//
// WHY THIS FILE EXISTS. Until 2026-09-16 the portal field was filled by
// condensing a long-form bullet by hand at submission time. That text lived
// nowhere: not in git, not in a review, not in a test. Nineteen of the long
// bullets were over the field's limit, several by three times, so nineteen
// sentences were rewritten live in a browser field with nothing checking that
// the rewrite stayed true.
//
// The fix is that the SHORT string is now the artefact. It is written in the
// doc, one line per hint per tool, and this file holds it to four things:
//
//   1. every tool `tools/list` advertises has all three short strings;
//   2. each is non-empty once trimmed;
//   3. each fits the portal's field;
//   4. the doc documents no tool the server does not advertise.
//
// (4) overlaps tool-surface.test.ts on purpose. The two parsers read different
// parts of the same file (headings there, bullets here), and a tool added to
// one and not the other is exactly the drift both exist to catch.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { isAdvertisedTool } from "./advertised-schema.ts";

// See the note in tool-surface.test.ts: index.ts builds its registry at module
// load and reads env while doing it, so the environment is arranged before the
// dynamic import runs.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { TOOL_REGISTRY } = await import("./index.ts");

/**
 * The portal's per-field limit.
 *
 * Asserted rather than measured: the only place the number is stated is the
 * submission portal itself, and that must not be opened while a version is in
 * review (an edit reverts the submission to draft). 200 is what the doc has
 * always claimed and what the strings are written to. If the real limit turns
 * out to differ, move this constant and re-cut the strings in the doc.
 */
const FIELD_LIMIT = 200;

const DOC_PATH = new URL(
  "../../../docs/openai-tool-annotation-justifications.md",
  import.meta.url,
);

const HINTS = ["readOnlyHint", "destructiveHint", "openWorldHint"] as const;
type Hint = typeof HINTS[number];

function advertisedToolNames(): string[] {
  return TOOL_REGISTRY
    .filter((tool) => isAdvertisedTool(tool.name))
    .map((tool) => tool.name);
}

/**
 * The submitted strings, parsed back out of the file they are pasted from.
 *
 * Shape, per tool:
 *
 *   ## <tool> (readOnly: X, destructive: Y, openWorld: Z)
 *   **Submitted text.**
 *   - **readOnlyHint:** ...
 *   - **destructiveHint:** ...
 *   - **openWorldHint:** ...
 *
 * The long-form bullets below each block are deliberately spelled differently
 * (`- **readOnly true:**`, no "Hint"), so this pattern cannot pick one up and
 * silently pass a 400-character paragraph off as the submitted line.
 */
function submittedStrings(markdown: string): Record<string, Partial<Record<Hint, string>>> {
  const out: Record<string, Partial<Record<Hint, string>>> = {};
  const sections = markdown.split(/^## /m).slice(1);
  for (const section of sections) {
    const name = section.split(/\s/, 1)[0];
    if (!name) continue;
    const entry: Partial<Record<Hint, string>> = {};
    const bullet = /^- \*\*(readOnlyHint|destructiveHint|openWorldHint):\*\* (.+)$/gm;
    for (const match of section.matchAll(bullet)) {
      const hint = match[1] as Hint;
      // First occurrence wins, so a second mention further down a block can
      // never quietly replace the line that ships.
      if (entry[hint] === undefined) entry[hint] = match[2].trim();
    }
    if (Object.keys(entry).length > 0) out[name] = entry;
  }
  return out;
}

const DOC = await Deno.readTextFile(DOC_PATH);
const SUBMITTED = submittedStrings(DOC);

Deno.test("every advertised tool has a submitted string for all three hints", () => {
  for (const name of advertisedToolNames()) {
    const entry = SUBMITTED[name];
    assert(
      entry,
      `${name} is advertised by tools/list but has no "Submitted text." block in ` +
        `docs/openai-tool-annotation-justifications.md. The portal needs one line ` +
        `per hint and there is nowhere else it is written down.`,
    );
    for (const hint of HINTS) {
      assert(
        typeof entry![hint] === "string",
        `${name} has no submitted ${hint} line. Add "- **${hint}:** ..." under its ` +
          `"Submitted text." heading.`,
      );
    }
  }
});

Deno.test("no submitted string is empty", () => {
  for (const [name, entry] of Object.entries(SUBMITTED)) {
    for (const hint of HINTS) {
      const text = entry[hint];
      if (text === undefined) continue;
      assert(
        text.trim().length > 0,
        `${name}.${hint} is blank. An empty justification field reads to a reviewer ` +
          `exactly like a missing one.`,
      );
    }
  }
});

Deno.test(`no submitted string exceeds the ${FIELD_LIMIT}-character field`, () => {
  const over: string[] = [];
  for (const [name, entry] of Object.entries(SUBMITTED)) {
    for (const hint of HINTS) {
      const text = entry[hint];
      if (text === undefined) continue;
      if (text.length > FIELD_LIMIT) over.push(`${name}.${hint} is ${text.length}`);
    }
  }
  assertEquals(
    over,
    [],
    `over the ${FIELD_LIMIT}-character portal field: ${over.join(", ")}. ` +
      `Cut it HERE and re-run, never in the portal: a sentence shortened in a ` +
      `browser field is a sentence nothing checked for truth.`,
  );
});

Deno.test("the submitted strings cover the live tool surface and nothing else", () => {
  // Same assertion tool-surface.test.ts makes about the headings, made about
  // the bullets, because they are parsed separately and can drift apart.
  assertEquals(
    Object.keys(SUBMITTED).sort(),
    advertisedToolNames().sort(),
    "the set of tools with submitted strings differs from what tools/list advertises",
  );
});

Deno.test("a submitted string never contradicts its own heading by claiming read-only", () => {
  // The single sentence the rejection quoted back at us: "describing the tool
  // as functionally read-only in the justification doesn't make the tool
  // read-only". A write tool whose submitted text says "read-only" or "it is a
  // read" is that failure, verbatim, in the field the reviewer reads.
  const writers = TOOL_REGISTRY
    .filter((tool) => isAdvertisedTool(tool.name))
    .filter((tool) => tool.annotations?.readOnlyHint !== true)
    .map((tool) => tool.name);
  for (const name of writers) {
    for (const hint of HINTS) {
      const text = SUBMITTED[name]?.[hint];
      if (!text) continue;
      const lower = text.toLowerCase();
      assert(
        !lower.includes("read-only") && !lower.includes("it is a read"),
        `${name} publishes readOnlyHint: false, but its submitted ${hint} line calls ` +
          `it a read: "${text}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Two guards added when this file was reconciled against the 2026-09-16
// draft-editor gating fix. Both are about the draft-editor blocks, which are
// the part of the doc that has now been rewritten twice because the code moved
// under it.
// ---------------------------------------------------------------------------

/**
 * The module whose error codes and behaviour the draft-editor blocks describe.
 *
 * Read as TEXT rather than imported: what is being pinned is that a code name
 * the doc quotes is a string the server can actually produce, and the error
 * codes are positional arguments to `draftFailure`, not exported constants.
 */
const DRAFT_MODULE = await Deno.readTextFile(
  new URL("./mcp-app-drafts.ts", import.meta.url),
);

Deno.test("every error_code the doc quotes is one the server can emit", () => {
  // The reconciliation this guards: `draft_editor_hidden` is a NEW code,
  // distinct from `draft_editor_disabled`, introduced when the user's opt-out
  // stopped being ANDed into the rollout gate, and `insufficient_role` is new
  // on this tool with the owner/admin check at workspace grain. A doc that
  // names a code the handler does not produce is describing behaviour that
  // does not happen, which is the class of mismatch v1.0.0 was rejected for.
  const quoted = [...DOC.matchAll(/`error_code: ([a-z_]+)`/g)].map((m) => m[1]);
  assert(quoted.length > 0, "the doc quotes no error codes at all — the parser has drifted");
  const missing = [...new Set(quoted)].filter((code) => !DRAFT_MODULE.includes(`"${code}"`));
  assertEquals(
    missing,
    [],
    `docs/openai-tool-annotation-justifications.md quotes error codes that ` +
      `mcp-app-drafts.ts does not emit: ${missing.join(", ")}`,
  );
});

const DRAFT_EDITOR_TOOLS = ["draft_read", "draft_editor_save", "draft_editor_hide"];

/**
 * Does a dashboard control for the draft editor ACTUALLY EXIST in this tree?
 *
 * This replaces a hardcoded `false`. When the guard below was written there was
 * no control — `apps/web` mentioned `draft_editor` only in two PATCH routes and
 * the generated types — so "never say dashboard" was a true statement about the
 * world, written down as a constant. It has stopped being one: a workspace
 * switch in Settings and a per-inbox switch in the inbox detail modal shipped on
 * `feat/draft-editor-toggle` -> `toggle/round2` (c39b3de).
 *
 * Deleting the guard is the wrong way to absorb that. What it is really for is
 * "the submitted text must not promise a control that does not exist", and that
 * sentence is still worth enforcing — it just has to be ASKED of the repository
 * rather than asserted from memory. So the ban now lifts by itself on the merge
 * that brings the control in, and stays in force everywhere it has not landed,
 * including on this branch today.
 *
 * TWO PIECES OF EVIDENCE, BOTH REQUIRED, because either alone is reachable
 * without a usable control:
 *
 *   * a `draftEditor` key in `apps/web/messages/en/dashboard.json` — a control a
 *     person can operate has copy, and a locale string is exactly what the
 *     original note said was missing;
 *   * a dashboard COMPONENT that renders it, so a stranded locale key left
 *     behind by a reverted feature cannot unlock the word on its own. Test files
 *     do not count.
 *
 * It deliberately does NOT check the two PATCH routes: those existed throughout
 * the period this guard was written for, and hand-crafting an authenticated
 * PATCH is not "changing it in the dashboard".
 */
function dashboardDraftEditorControlExists(): boolean {
  const webRoot = new URL("../../../apps/web/", import.meta.url);

  let hasCopy = false;
  try {
    const messages = Deno.readTextFileSync(new URL("messages/en/dashboard.json", webRoot));
    hasCopy = /"draftEditor"\s*:/.test(messages);
  } catch {
    return false;
  }
  if (!hasCopy) return false;

  try {
    for (const entry of Deno.readDirSync(new URL("components/dashboard/", webRoot))) {
      if (!entry.isFile) continue;
      if (!/\.(jsx|tsx|js|ts)$/.test(entry.name)) continue;
      if (entry.name.includes(".test.")) continue;
      const source = Deno.readTextFileSync(
        new URL(`components/dashboard/${entry.name}`, webRoot),
      );
      if (/draftEditor|draft_editor/i.test(source)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

Deno.test("no submitted string promises a dashboard control the repo does not have", () => {
  // `destructiveHint: false` on `draft_editor_hide` used to lean on "a signed-in
  // owner or admin can set it back", meaning in the dashboard, which was not a
  // thing anyone could do. It now leans on the tool reversing itself at either
  // scope — `allowWhileHidden: true`, unconditionally — which is real and is
  // pinned by the test below. The dashboard is a second route and the submitted
  // text does not use it: a reviewer cannot see our dashboard, so a
  // justification resting on a screen they cannot check is weaker than one
  // describing the tool in front of them.
  //
  // Relaxed rather than removed: the check is now "is this true", not "is this
  // the word dashboard". See `dashboardDraftEditorControlExists`.
  if (dashboardDraftEditorControlExists()) return;
  for (const name of DRAFT_EDITOR_TOOLS) {
    for (const hint of HINTS) {
      const text = SUBMITTED[name]?.[hint];
      if (!text) continue;
      assert(
        !text.toLowerCase().includes("dashboard"),
        `${name}.${hint} points the reviewer at a dashboard control for the draft ` +
          `editor, and there is none in this tree: apps/web has no dashboard ` +
          `component and no en/dashboard.json draftEditor copy for it. The control ` +
          `exists on toggle/round2; until that merges this claim is one a reviewer ` +
          `could check and find false. Submitted text: "${text}"`,
      );
    }
  }
});

Deno.test("the reversal the destructiveHint:false case rests on is still unconditional", () => {
  // What the guard above stops leaning on, this one holds up. Every reversal
  // claim in the `draft_editor_hide` block — the submitted destructiveHint line
  // ("hidden:false sets it back at either scope"), the idempotence argument, and
  // the tool's own advertised description — reduces to one fact: this is the
  // only tool that passes `allowWhileHidden` to `gateDraftTool`, and it passes a
  // literal `true` rather than something derived from the arguments.
  //
  // It has already been wrong twice. Gated on the flag it writes, a
  // workspace-scope hide disabled the only tool that could undo it; passed as
  // `allowWhileHidden: hidden === false`, a hide crossed scopes and stopped
  // being repeatable. Either regression turns the annotation back into the kind
  // of mismatch v1.0.0 was rejected for, and neither would change a word of the
  // doc, so nothing else here would notice.
  //
  // Comments are stripped first: the module's own history note quotes the
  // conditional form verbatim, and a guard that a code comment can fail is a
  // guard nobody keeps.
  const code = DRAFT_MODULE
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  // `allowWhileHidden?:` is the option-bag type and is not a call site.
  const passed = [...code.matchAll(/\ballowWhileHidden(\??):\s*([^,\n}]+)/g)]
    .filter((m) => m[1] !== "?")
    .map((m) => m[2].trim());
  assertEquals(
    passed,
    ["true"],
    `mcp-app-drafts.ts should pass allowWhileHidden exactly once, as a literal ` +
      `true, from runDraftEditorHide. Found: ${JSON.stringify(passed)}. A second ` +
      `call site, or a value derived from the arguments, breaks the reversal the ` +
      `draft_editor_hide block's destructiveHint: false argument rests on.`,
  );
});
