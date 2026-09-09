// ---------------------------------------------------------------------------
// SERVER_INSTRUCTIONS: the two ways this string has actually broken.
//
// It is the `instructions` field of our `initialize` result, so it is the
// first thing a model reads about this server and, under Claude Code's tool
// search, the ONLY thing that loads at session start: tool schemas are
// deferred until something asks for them, this string never is. It is
// therefore both the highest-leverage text we ship and the most expensive,
// paid for once per session by every user forever.
//
// FAILURE ONE: it went stale. 83bbbcc split the read halves of `folder`,
// `draft`, `schedule`, `signature` and `automation` onto tools of their own,
// and 1c320a6 moved the destructive sweep off `email_organize`. Both commits
// updated the tool descriptions. Neither touched this block, which went on
// advertising action enums that no longer existed and a `signature` tool that
// `tools/list` had stopped emitting. Nothing connected the string to the
// registry it describes, so nothing noticed for months.
//
// FAILURE TWO: it outgrew its budget silently. Claude Code truncates server
// instructions at 2KB (https://code.claude.com/docs/en/mcp, "For MCP server
// authors"), mid-sentence and with no error on either side. By 2026-09-09 the
// string was 3,027 bytes, so roughly a third of it, including the whole
// untrusted-content rule, was being cut off in production and no test or log
// could have told us.
//
// Both failures are invisible at runtime, which is why they need a test rather
// than a review habit. The rewrite is today's instance; this file is the part
// that has to outlive it.
//
// The registry has to come out of index.ts itself for the same reason
// tool-surface.test.ts imports it: a fixture copy of the tool names is exactly
// the thing that would drift away from the real surface, which is the drift
// being tested for.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAdvertisedTool } from "./advertised-schema.ts";

// index.ts builds its registry at module load and reads env while doing it, so
// the environment has to be arranged BEFORE the import runs. A static import is
// hoisted above these calls, hence the dynamic one. Same preamble as
// tool-surface.test.ts, and for the same reason.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
const { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_MAX_BYTES, TOOL_REGISTRY } = await import(
  "./index.ts"
);

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * Identifiers the string is allowed to name that are NOT tools: argument names
 * and result fields. Deliberately short and explicit. Anything snake_cased or
 * backticked that is neither a live tool nor on this list fails the test,
 * because the whole point is that an identifier nobody recognises should stop
 * a commit rather than ship.
 */
const NON_TOOL_IDENTIFIERS = new Set([
  "inbox", // the email-address alternative to inbox_id
  "inbox_id", // the UUID form
  "untrusted_content", // the structuredContent flag on mailbox-derived results
]);

/** snake_case runs anywhere in the prose, backticked or bare. */
const SNAKE_CASE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
/** Anything in backticks, which is how single-word tool names appear. */
const BACKTICKED = /`([^`]+)`/g;
/** A family reference such as `approval_*`, which stands for several tools. */
const WILDCARD = /`([a-z][a-z0-9_]*)_\*`/g;

/** Every identifier the instructions name, however they are written. */
function mentionedIdentifiers(): Set<string> {
  const found = new Set<string>();
  for (const match of SERVER_INSTRUCTIONS.matchAll(SNAKE_CASE)) found.add(match[0]);
  for (const match of SERVER_INSTRUCTIONS.matchAll(BACKTICKED)) {
    // Strip the trailing `: true` of a flag reference and any stray
    // punctuation, so `untrusted_content: true` reads as one identifier.
    const token = match[1].split(":")[0].trim();
    if (/^[a-z][a-z0-9_]*$/.test(token)) found.add(token);
  }
  return found;
}

Deno.test("SERVER_INSTRUCTIONS stays inside its byte budget", () => {
  const bytes = byteLength(SERVER_INSTRUCTIONS);
  console.log(
    `SERVER_INSTRUCTIONS: ${bytes} bytes of ${SERVER_INSTRUCTIONS_MAX_BYTES} ` +
      `(${SERVER_INSTRUCTIONS_MAX_BYTES - bytes} spare, Claude Code truncates at 2048)`,
  );
  assert(
    bytes <= SERVER_INSTRUCTIONS_MAX_BYTES,
    `SERVER_INSTRUCTIONS is ${bytes} bytes, over its ${SERVER_INSTRUCTIONS_MAX_BYTES}-byte ` +
      "budget. Claude Code truncates server instructions at 2048 bytes, mid-sentence and " +
      "silently, so going over does not fail anywhere else. Cut something rather than " +
      "raising the number: anything that restates one tool's own schema belongs in that " +
      "tool's description, which the client already reads.",
  );
  // Guard the other direction too. The budget is only meaningful while it sits
  // under the client's real ceiling; raising it past 2048 would make the test
  // pass while production truncates.
  assert(
    SERVER_INSTRUCTIONS_MAX_BYTES <= 2048,
    "SERVER_INSTRUCTIONS_MAX_BYTES must stay at or under Claude Code's documented " +
      "2048-byte truncation point. See https://code.claude.com/docs/en/mcp.",
  );
});

Deno.test("SERVER_INSTRUCTIONS names only tools that exist and are advertised", () => {
  const registry = new Set(TOOL_REGISTRY.map((tool: { name: string }) => tool.name));
  const unknown: string[] = [];
  const withheld: string[] = [];

  for (const identifier of mentionedIdentifiers()) {
    if (NON_TOOL_IDENTIFIERS.has(identifier)) continue;
    if (!registry.has(identifier)) {
      unknown.push(identifier);
      continue;
    }
    // A tool can be in the registry and still never reach a client: `signature`
    // is registered so pre-split sessions keep working, but `isAdvertisedTool`
    // withholds it from tools/list. Telling a model to call it is the same
    // defect as naming a tool that does not exist.
    if (!isAdvertisedTool(identifier)) withheld.push(identifier);
  }

  assertEquals(
    unknown,
    [],
    "SERVER_INSTRUCTIONS names identifiers that are neither tools in TOOL_REGISTRY nor " +
      "listed in NON_TOOL_IDENTIFIERS. Either the tool was renamed or removed and this " +
      "string was not updated with it, or a new argument name needs adding to that list.",
  );
  assertEquals(
    withheld,
    [],
    "SERVER_INSTRUCTIONS names tools that are registered but withheld from tools/list, " +
      "so a client is being pointed at something it cannot see.",
  );
});

Deno.test("every tool family the instructions reference has members", () => {
  // `approval_*` and `bulk_*` stand in for six app-only tools rather than
  // listing them, which is the right trade at this budget but means a rename
  // of the whole family would leave the reference silently pointing at
  // nothing. Wildcards get checked as wildcards.
  const families = [...SERVER_INSTRUCTIONS.matchAll(WILDCARD)].map((match) => match[1]);
  assert(families.length > 0, "expected at least one tool family reference such as `bulk_*`");

  for (const family of families) {
    const members = TOOL_REGISTRY.filter((tool: { name: string }) =>
      tool.name.startsWith(`${family}_`)
    );
    assert(
      members.length > 0,
      `SERVER_INSTRUCTIONS references the \`${family}_*\` tool family, but no tool in ` +
        "TOOL_REGISTRY has that prefix.",
    );
  }
});

Deno.test("the inbox-selection rule sits in the head of the string", () => {
  // Claude Code's own advice for this field is to "put critical details near
  // the start", precisely because truncation takes the tail. Inbox discovery
  // is the detail that qualifies: a model that guesses an inbox_id acts on the
  // wrong mailbox, and one that reads a missing inbox_id as a dead end stops
  // working entirely, which is the behaviour this paragraph was written to
  // fix. It must survive a cut, so it has to be inside the first 2048 bytes
  // with room to spare rather than merely inside the string.
  const head = new TextDecoder().decode(
    new TextEncoder().encode(SERVER_INSTRUCTIONS).slice(0, 1024),
  );
  assert(
    head.includes("inbox_id"),
    "the inbox-selection rule must stay in the first 1KB, where a truncating client " +
      "still sees it.",
  );
});
