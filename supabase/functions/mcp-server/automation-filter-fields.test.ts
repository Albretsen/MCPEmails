// ---------------------------------------------------------------------------
// The automation filter field list, in the two places that state it.
//
// WHY THIS FILE EXISTS. Until 2026-09-15 the two disagreed, and had done since
// the feature shipped (8a52f8c): ALLOWED_FILTER_STRING_FIELDS in
// triage-engine.ts contained "raw" while the automation tool schemas in
// index.ts told every caller, in bold, that provider-native `raw` queries are
// NOT accepted for automations. One of them had to be wrong, and the one that
// was wrong was the one that actually decided what a mailbox got searched for:
// a filter of `{raw: "ALL"}` satisfied the "at least one criterion" guard and
// then translated to the RFC 3501 key ALL, i.e. the whole mailbox, on a rule
// that re-runs every fifteen minutes with nobody watching.
//
// A comment cannot keep those two in step, so this does. Both directions are
// covered on purpose: adding a field to the allow-list without documenting it
// fails here just as loudly as documenting one that is not accepted.
//
// Run: DENO_NO_PACKAGE_JSON=1 deno test --allow-read --allow-env \
//        supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { toImapSearch } from "./search-translate.ts";
import {
  ALLOWED_FILTER_BOOL_FIELDS,
  ALLOWED_FILTER_DATE_FIELDS,
  ALLOWED_FILTER_STRING_FIELDS,
  validateTriageFilter,
} from "./triage-engine.ts";

// index.ts builds its registry at module load and reads env while doing it, so
// the environment has to be arranged BEFORE the import runs. Same dance, and
// for the same reasons, as tool-surface.test.ts.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
// deno-lint-ignore no-explicit-any
const { TOOL_REGISTRY } = await import("./index.ts") as any;

const ACCEPTED_FIELDS = [
  ...ALLOWED_FILTER_STRING_FIELDS,
  ...ALLOWED_FILTER_BOOL_FIELDS,
  ...ALLOWED_FILTER_DATE_FIELDS,
];

/** Every registered tool that takes a stored automation filter. */
function toolsWithAFilter(): { name: string; description: string }[] {
  // deno-lint-ignore no-explicit-any
  return (TOOL_REGISTRY as any[])
    .map((tool) => ({ name: tool.name as string, filter: tool.inputSchema?.properties?.filter }))
    .filter((entry) => entry.filter && typeof entry.filter.description === "string")
    .map((entry) => ({ name: entry.name, description: entry.filter.description as string }));
}

/**
 * The field names a schema description advertises.
 *
 * The descriptions all read "...the same structured criteria email_search
 * takes: from, to, cc, ... before." The anchor is asserted rather than
 * defaulted: a description that stops naming its fields must fail this test,
 * not quietly pass it with an empty list.
 */
function advertisedFields(description: string): string[] {
  const anchor = "email_search takes:";
  const at = description.indexOf(anchor);
  assert(at !== -1, `the filter description no longer says "${anchor}", so it cannot be checked`);
  const listStart = at + anchor.length;
  const listEnd = description.indexOf(".", listStart);
  assert(listEnd !== -1, "the field list in the filter description is unterminated");
  return description.slice(listStart, listEnd).split(",").map((field) => field.trim()).filter(Boolean);
}

Deno.test("the tool schemas advertise exactly the filter fields the validator accepts", () => {
  const tools = toolsWithAFilter();
  // A rename that drops the property would otherwise make every assertion below
  // vacuously true.
  assert(tools.length > 0, "no registered tool takes a filter any more; this test needs rewriting");

  for (const tool of tools) {
    assertEquals(
      advertisedFields(tool.description).slice().sort(),
      ACCEPTED_FIELDS.slice().sort(),
      `${tool.name} advertises a different filter field list than validateTriageFilter accepts`,
    );
  }
});

Deno.test("'raw' is refused, and every automation schema says so", () => {
  assert(
    !(ACCEPTED_FIELDS as readonly string[]).includes("raw"),
    "raw is a provider-native dialect nothing validates; it is not storable in an unattended rule",
  );

  for (const tool of toolsWithAFilter()) {
    assert(
      tool.description.includes("'raw' queries are NOT accepted"),
      `${tool.name} no longer tells callers that raw is refused, but the validator still refuses it`,
    );
  }

  // Refused on its own, refused alongside a criterion that would otherwise
  // carry the filter, and refused rather than silently dropped: a rule that
  // stores less than the caller asked for is a rule that matches more mail
  // than the caller asked for.
  for (const filter of [{ raw: "ALL" }, { from: "billing@acme.com", raw: "OR FROM a@b.c FROM d@e.f" }]) {
    const result = validateTriageFilter(filter);
    assert(!result.ok, `${JSON.stringify(filter)} must not be storable as an automation filter`);
    assert(
      !result.ok && result.error.includes("raw"),
      "the refusal has to name the field, or a caller reads it as a generic typo",
    );
  }
});

Deno.test("the reason raw is refused: it walks past the empty-filter guard", () => {
  // The guard in validateTriageFilter refuses a filter with no criteria,
  // because an unattended rule that matches the whole mailbox is never what
  // anyone meant. `{raw: "ALL"}` had exactly one criterion and meant exactly
  // that. This pins the translation so the rationale above cannot rot into a
  // story about a risk that no longer exists.
  assertEquals(toImapSearch({ raw: "ALL" }), "ALL", "a raw 'ALL' is a whole-mailbox IMAP search");
  assert(!validateTriageFilter({}).ok, "the empty filter is refused");
  assert(!validateTriageFilter({ raw: "ALL" }).ok, "and so is the spelling that got around it");
});
