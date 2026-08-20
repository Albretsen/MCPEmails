// ---------------------------------------------------------------------------
// The validation message is what a model reads when it got a call wrong, and
// whether it can recover on the next attempt depends entirely on what survives
// into this string.
//
// These assertions are about behaviour, not wording: the offending argument and
// the rule it broke must be named, the valid actions must be enumerated, the
// caller must be told the call did not run, and the text must not address the
// model in the imperative. Rewording the sentences is fine. Losing any of those
// properties is not.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  buildInvalidArgumentsText,
  buildUnknownActionText,
} from "./invalid-arguments-message.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}: expected to find ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}

Deno.test("schema rejection names every offending argument and its rule", () => {
  const text = buildInvalidArgumentsText("email_read", [
    { path: "arguments.since", message: "must be an ISO 8601 date or date-time" },
    { path: "arguments.limit", message: "must be less than or equal to 100" },
  ]);
  assertIncludes(text, "email_read", "the tool that rejected the call");
  assertIncludes(text, "arguments.since must be an ISO 8601 date or date-time", "first field");
  assertIncludes(text, "arguments.limit must be less than or equal to 100", "second field");
});

Deno.test("schema rejection states the call never ran", () => {
  const text = buildInvalidArgumentsText("email_compose", [
    { path: "arguments.to", message: "is required" },
  ]);
  // A model that cannot rule out a partial send will either refuse to retry or
  // send the message twice. Both are worse than the original mistake.
  assertIncludes(text, "before it ran", "the call did not reach the provider");
  assertIncludes(text, "nothing was read, sent, moved or deleted", "no side effects");
});

Deno.test("schema rejection tells the caller an identical retry is pointless", () => {
  const text = buildInvalidArgumentsText("email_read", [
    { path: "arguments.since", message: "must be an ISO 8601 date or date-time" },
  ]);
  assertIncludes(text, "rejected the same way", "retry futility");
});

Deno.test("schema rejection caps how many failures it spells out", () => {
  const errors = Array.from({ length: 14 }, (_, index) => ({
    path: `arguments.field_${index}`,
    message: "is not allowed",
  }));
  const text = buildInvalidArgumentsText("draft", errors);
  assertIncludes(text, "arguments.field_9", "the tenth failure is still listed");
  assert(!text.includes("arguments.field_10"), "the eleventh is not");
  assertIncludes(text, "4 further argument problems not listed", "the remainder is counted");
});

Deno.test("missing action enumerates the valid actions", () => {
  const text = buildUnknownActionText("email_compose", null, ["send", "reply", "forward"]);
  assertIncludes(text, "requires an 'action' argument", "what was missing");
  assertIncludes(text, "send, reply, forward", "the whole enum, which is the entire remedy");
  assertIncludes(text, "before it ran", "no mail was sent");
});

Deno.test("unknown action echoes what was sent so a typo is visible", () => {
  const text = buildUnknownActionText("email_compose", "sendmail", ["send", "reply", "forward"]);
  assertIncludes(text, "'sendmail'", "the rejected value");
  assertIncludes(text, "send, reply, forward", "the valid values");
});

Deno.test("unknown action truncates an oversized value instead of echoing it whole", () => {
  const text = buildUnknownActionText("folder", "x".repeat(500), ["list", "create"]);
  assert(text.length < 400, `a 500-character value must not pass through: ${text.length}`);
});

Deno.test("no message instructs the model to do anything", () => {
  const texts = [
    buildInvalidArgumentsText("email_read", [
      { path: "arguments.since", message: "must be an ISO 8601 date or date-time" },
    ]),
    buildUnknownActionText("email_compose", null, ["send", "reply", "forward"]),
  ];
  // Imperatives aimed at a model from inside a tool response are mechanically
  // indistinguishable from prompt injection by the server operator. State
  // facts; let the model decide what to do with them.
  const imperatives = [
    "you should",
    "you must",
    "please ",
    "retry with",
    "call the",
    "tell the user",
    "instead use",
    "use the",
  ];
  for (const text of texts) {
    for (const imperative of imperatives) {
      assert(
        !text.toLowerCase().includes(imperative),
        `message must not instruct the model (${imperative}): ${text}`,
      );
    }
  }
});
