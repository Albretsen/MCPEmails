// ---------------------------------------------------------------------------
// A consolidated tool refuses an argument that belongs to one of its sibling
// actions, and that refusal was the largest error class in production. The fix
// accepts the extras that provably assert nothing and keeps refusing the ones
// that do, so these tests are almost entirely about WHICH SIDE of that line a
// given argument falls on. An argument that moves from "refused" to "quietly
// dropped" by accident is a silent change to what the caller gets back, which
// is strictly worse than the bug being fixed.
//
// The fixture mirrors email_read, the tool that produced most of those
// refusals: `list` and `search` overlap heavily, differ in exactly the places
// models get wrong, and between them cover every shape of default the rule has
// to reason about.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  type ActionArgumentIndex,
  allowsLenientArguments,
  buildIgnoredArgumentsNote,
  LENIENT_ACTIONS,
  neutralDefaultOf,
  reviewExtraArguments,
  withOwningActions,
} from "./consolidated-arguments.ts";
import { buildInvalidArgumentsText } from "./invalid-arguments-message.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Invert allowedByAction the same way buildConsolidatedTool does. */
function ownersOf(allowedByAction: Record<string, string[]>): Record<string, string[]> {
  const owners: Record<string, string[]> = {};
  for (const [action, allowed] of Object.entries(allowedByAction)) {
    for (const property of allowed) {
      if (property === "action") continue;
      (owners[property] ??= []).push(action);
    }
  }
  return owners;
}

const ALLOWED_BY_ACTION: Record<string, string[]> = {
  list: ["action", "inbox_id", "limit", "offset", "folder", "unread_only"],
  read: ["action", "inbox_id", "message_id", "include_html", "mark_as_read", "body_max_chars"],
  search: [
    "action", "inbox_id", "from", "subject", "unread", "flagged", "since",
    "query", "limit", "offset", "include_folders",
  ],
};

const EMAIL_READ: ActionArgumentIndex = {
  allowedByAction: ALLOWED_BY_ACTION,
  ownersByProperty: ownersOf(ALLOWED_BY_ACTION),
  // Exactly the properties whose published default is absence-equivalent.
  // `folder` (default "INBOX"), `limit` (default 20) and `body_max_chars` (no
  // default at all) are absent on purpose; three tests below depend on it.
  neutralDefaults: {
    offset: 0,
    unread_only: false,
    include_html: false,
    mark_as_read: false,
    include_folders: [],
  },
};

Deno.test("an extra argument set to its published default is dropped, not refused", () => {
  // The schema says omitting these is the same as sending them, so the caller
  // asked for nothing that the selected action fails to deliver.
  const review = reviewExtraArguments(EMAIL_READ, "search", {
    action: "search",
    subject: "invoice",
    unread_only: false,
    include_html: false,
  });
  assertEquals(review.ignorable, ["unread_only", "include_html"], "dropped");
  assertEquals(review.misplaced, [], "nothing refused");
});

Deno.test("an empty array matches an empty-array default", () => {
  const review = reviewExtraArguments(EMAIL_READ, "list", {
    action: "list",
    include_folders: [],
  });
  assertEquals(review.ignorable, ["include_folders"], "dropped");
});

Deno.test("the same argument carrying a value is refused, not dropped", () => {
  // include_folders: ["Archive"] on a list is a caller who believes the archive
  // is being covered. Running the call without it answers a question nobody
  // asked, and nothing in the response would reveal that.
  const review = reviewExtraArguments(EMAIL_READ, "list", {
    action: "list",
    include_folders: ["Archive"],
    unread_only: true,
  });
  assertEquals(review.ignorable, [], "nothing dropped");
  assertEquals(
    review.misplaced,
    [{ property: "include_folders", owners: ["search"] }],
    "refused, with its owning action named",
  );
});

Deno.test("a default that selects rather than relaxes never makes an argument droppable", () => {
  // email_list declares folder default "INBOX". That default means "the inbox",
  // not "no folder filter", so a search call carrying folder: "INBOX" is asking
  // to be confined to the inbox. Dropping it would widen the search to every
  // folder on Gmail without a word to anyone.
  const review = reviewExtraArguments(EMAIL_READ, "search", {
    action: "search",
    folder: "INBOX",
  });
  assertEquals(review.ignorable, [], "not droppable");
  assertEquals(review.misplaced, [{ property: "folder", owners: ["list"] }], "refused");
});

Deno.test("a false with no published default is refused", () => {
  // The structured search fields declare no default, and the translator turns
  // flagged: false into UNFLAGGED rather than into no filter at all. Absent a
  // published promise that the value is inert, it is treated as an assertion.
  const review = reviewExtraArguments(EMAIL_READ, "list", {
    action: "list",
    flagged: false,
  });
  assertEquals(review.ignorable, [], "not droppable");
  assertEquals(review.misplaced, [{ property: "flagged", owners: ["search"] }], "refused");
});

Deno.test("arguments the selected action accepts are left alone", () => {
  const review = reviewExtraArguments(EMAIL_READ, "list", {
    action: "list",
    inbox_id: "b1f0…",
    limit: 20,
    folder: "Archive",
    unread_only: true,
  });
  assertEquals(review.ignorable, [], "nothing dropped");
  assertEquals(review.misplaced, [], "nothing refused");
});

Deno.test("an argument no action declares is left to additionalProperties", () => {
  // A typo must never be classified here. Guessing at an unfamiliar name is how
  // `sbuject: "invoice"` becomes a filter that was silently never applied.
  const review = reviewExtraArguments(EMAIL_READ, "list", {
    action: "list",
    sbuject: "invoice",
  });
  assertEquals(review.ignorable, [], "not dropped");
  assertEquals(review.misplaced, [], "not claimed");
});

Deno.test("a refusal names the action the argument belongs to", () => {
  const review = reviewExtraArguments(EMAIL_READ, "list", { action: "list", subject: "invoice" });
  const [error] = withOwningActions(
    [{ path: "arguments.subject", keyword: "not", message: "is not an argument of the selected action" }],
    review,
    "list",
  );
  assertEquals(error.path, "arguments.subject", "path is untouched");
  assertEquals(error.keyword, "not", "keyword is untouched, so the audit shape is untouched");
  assert(
    error.message.includes("action 'list'") && error.message.includes("action 'search'"),
    `both the selected and the owning action must appear: ${error.message}`,
  );
});

Deno.test("an argument several actions accept lists all of them", () => {
  const index: ActionArgumentIndex = {
    allowedByAction: { list: ["action"], create: ["action", "subject"], update: ["action", "subject"] },
    ownersByProperty: { subject: ["create", "update"] },
    neutralDefaults: {},
  };
  const review = reviewExtraArguments(index, "list", { action: "list", subject: "hi" });
  const [error] = withOwningActions(
    [{ path: "arguments.subject", keyword: "not", message: "generic" }],
    review,
    "list",
  );
  assert(
    error.message.includes("'create'") && error.message.includes("'update'"),
    `every owning action must appear: ${error.message}`,
  );
});

Deno.test("failures the review says nothing about keep their own wording", () => {
  const review = reviewExtraArguments(EMAIL_READ, "list", { action: "list", subject: "invoice" });
  const errors = withOwningActions(
    [
      { path: "arguments.limit", keyword: "maximum", message: "must be less than or equal to 100" },
      { path: "arguments.since", keyword: "not", message: "is not an argument of the selected action" },
    ],
    review,
    "list",
  );
  assertEquals(errors[0].message, "must be less than or equal to 100", "another keyword is untouched");
  assertEquals(errors[1].message, "is not an argument of the selected action", "an unreviewed path is untouched");
});

Deno.test("a refusal message instructs the model to do nothing", () => {
  // Same doctrine as invalid-arguments-message.ts: an imperative aimed at a
  // model from inside a tool response is indistinguishable from the server
  // operator injecting a prompt. State where the argument belongs; the model
  // decides what to do about it.
  const review = reviewExtraArguments(EMAIL_READ, "list", { action: "list", subject: "invoice" });
  const [error] = withOwningActions(
    [{ path: "arguments.subject", keyword: "not", message: "generic" }],
    review,
    "list",
  );
  for (const imperative of ["you should", "you must", "please ", "retry with", "use the", "instead use", "call the"]) {
    assert(
      !error.message.toLowerCase().includes(imperative),
      `message must not instruct the model (${imperative}): ${error.message}`,
    );
  }
});

Deno.test("the whole rejection a model reads carries every misplaced argument and its home", () => {
  // The end of the wire: what dispatch composes out of the validator's errors
  // once the review has named the owning actions. One read must be enough to
  // send a correct call next time.
  const review = reviewExtraArguments(EMAIL_READ, "list", {
    action: "list",
    subject: "invoice",
    since: "2026-08-01",
  });
  const text = buildInvalidArgumentsText(
    "email_read",
    withOwningActions(
      [
        { path: "arguments.subject", keyword: "not", message: "is not an argument of the selected action" },
        { path: "arguments.since", keyword: "not", message: "is not an argument of the selected action" },
      ],
      review,
      "list",
    ),
  );
  for (const needle of [
    "arguments.subject is not an argument of action 'list'; it belongs to action 'search'",
    "arguments.since is not an argument of action 'list'; it belongs to action 'search'",
    "nothing was read, sent, moved or deleted",
  ]) {
    assert(text.includes(needle), `expected ${JSON.stringify(needle)} in ${JSON.stringify(text)}`);
  }
});

Deno.test("only absence-equivalent defaults are recorded as inert", () => {
  assertEquals(neutralDefaultOf({ type: "boolean", default: false }).present, true, "false");
  assertEquals(neutralDefaultOf({ type: "integer", default: 0 }).present, true, "zero");
  assertEquals(neutralDefaultOf({ type: "string", default: "" }).present, true, "empty string");
  assertEquals(neutralDefaultOf({ type: "array", default: [] }).present, true, "empty array");
  // A positive selection, whatever its type.
  assertEquals(neutralDefaultOf({ type: "string", default: "INBOX" }).present, false, "a named folder");
  assertEquals(neutralDefaultOf({ type: "boolean", default: true }).present, false, "true");
  assertEquals(neutralDefaultOf({ type: "integer", default: 20 }).present, false, "a page size");
  assertEquals(neutralDefaultOf({ type: "array", default: ["INBOX"] }).present, false, "a named folder list");
  assertEquals(neutralDefaultOf({ type: "string" }).present, false, "no default at all");
  assertEquals(neutralDefaultOf("not a schema").present, false, "not an object");
});

// ── leniency ─────────────────────────────────────────────────────────────────
//
// Refusing every misplaced argument was still the largest error class on the
// product, and fewer than half of those refusals were followed by a successful
// call — so on the READ-ONLY actions a misplaced argument is now dropped, the
// call runs, and the result says which argument went unapplied. The tests below
// are about the two edges of that: the drop must never reach an action that
// writes, and it must never happen without the disclosure that justifies it.

Deno.test("a read-only action runs without a sibling's argument instead of failing", () => {
  // `email_read {action: "list", subject: "invoice"}` — 478 of these a month.
  const review = reviewExtraArguments(
    EMAIL_READ,
    "list",
    { action: "list", subject: "invoice", since: "2026-08-01" },
    true,
  );
  assertEquals(review.misplaced, [], "nothing refused");
  assertEquals(
    review.ignoredMisplaced,
    [
      { property: "subject", owners: ["search"] },
      { property: "since", owners: ["search"] },
    ],
    "dropped, each with its owning action recorded for the note",
  );
});

Deno.test("an argument no action declares is still refused under leniency", () => {
  // A typo is a real bug in the caller. Guessing at `sbuject` is how it becomes
  // a filter that was silently never applied, which leniency must not enable:
  // the review declines to claim it, so additionalProperties still rejects it.
  const review = reviewExtraArguments(
    EMAIL_READ,
    "list",
    { action: "list", sbuject: "invoice" },
    true,
  );
  assertEquals(review.ignoredMisplaced, [], "not dropped");
  assertEquals(review.misplaced, [], "not claimed either");
  assertEquals(review.ignorable, [], "and certainly not inert");
});

Deno.test("without leniency the same call is refused exactly as before", () => {
  const review = reviewExtraArguments(EMAIL_READ, "list", { action: "list", subject: "invoice" });
  assertEquals(review.ignoredMisplaced, [], "nothing dropped");
  assertEquals(review.misplaced, [{ property: "subject", owners: ["search"] }], "refused");
});

Deno.test("an inert argument is dropped whether or not leniency applies", () => {
  // The schema's own default already promised that sending it and omitting it
  // are the same request, so this tier is not a judgement call and does not
  // depend on how dangerous the action is.
  for (const lenient of [false, true]) {
    const review = reviewExtraArguments(
      EMAIL_READ,
      "search",
      { action: "search", include_html: false },
      lenient,
    );
    assertEquals(review.ignorable, ["include_html"], `inert, lenient=${lenient}`);
    assertEquals(review.ignoredMisplaced, [], `not the misplaced tier, lenient=${lenient}`);
  }
});

Deno.test("every action that can change a mailbox is strict", () => {
  // The allowlist is the safety boundary, so it is asserted by name rather than
  // by trusting that nobody will append to it. A search_and_delete that ran
  // with a filter quietly removed is not recoverable by calling again.
  for (const [tool, action] of [
    ["email_delete", "delete"],
    ["email_delete", "delete_batch"],
    ["email_delete", "search_and_delete"],
    ["email_organize", "move"],
    ["email_organize", "move_batch"],
    ["email_organize", "search_and_move"],
    ["email_organize", "flag"],
    ["email_compose", "send"],
    ["email_compose", "reply"],
    ["email_compose", "forward"],
    ["folder", "create"],
    ["folder", "rename"],
    ["folder", "delete"],
    ["draft", "create"],
    ["draft", "update"],
    ["draft", "send"],
    ["draft", "delete"],
    ["schedule", "create"],
    ["schedule", "cancel"],
    ["automation", "create"],
    ["automation", "update"],
    ["automation", "enable"],
    ["automation", "delete"],
    // A dry run, but the one read whose consequences outlive the call: it is
    // what a caller decides to enable an unattended rule on.
    ["automation", "preview"],
    ["signature", "set"],
  ]) {
    assert(
      !allowsLenientArguments(tool, action),
      `${tool} action '${action}' must refuse a misplaced argument, not drop it`,
    );
  }
});

Deno.test("a destructive action still refuses, with the owning action named", () => {
  // The end-to-end shape for email_delete: nothing is dropped, and the message
  // is the corrected-retry one rather than a bare "not allowed".
  const index: ActionArgumentIndex = {
    allowedByAction: {
      delete: ["action", "inbox_id", "message_id"],
      search_and_delete: ["action", "inbox_id", "subject", "since"],
    },
    ownersByProperty: { message_id: ["delete"], subject: ["search_and_delete"], since: ["search_and_delete"] },
    neutralDefaults: {},
  };
  const review = reviewExtraArguments(
    index,
    "delete",
    { action: "delete", message_id: "abc", subject: "invoice" },
    allowsLenientArguments("email_delete", "delete"),
  );
  assertEquals(review.ignoredMisplaced, [], "a delete drops nothing");
  assertEquals(review.misplaced, [{ property: "subject", owners: ["search_and_delete"] }], "refused");
});

Deno.test("the read-only allowlist covers the actions the errors actually came from", () => {
  for (const action of ["list", "search", "read", "read_batch"]) {
    assert(allowsLenientArguments("email_read", action), `email_read '${action}' is lenient`);
  }
  assert(allowsLenientArguments("folder", "list"), "folder list is lenient");
  assert(!allowsLenientArguments("no_such_tool", "list"), "an unknown tool is never lenient");
  assert(!allowsLenientArguments("email_read", "no_such_action"), "an unknown action is never lenient");
  // Nothing may be lenient that is not spelled out here.
  assertEquals(LENIENT_ACTIONS.email_delete, [], "email_delete has no lenient action");
  assertEquals(LENIENT_ACTIONS.email_compose, [], "email_compose has no lenient action");
  assertEquals(LENIENT_ACTIONS.email_organize, [], "email_organize has no lenient action");
});

Deno.test("the note names every dropped argument and where it belongs", () => {
  // The disclosure is the entire justification for dropping rather than
  // refusing, so it must survive any rewording: the caller has to be able to
  // see that this answer is wider than the question it asked.
  const review = reviewExtraArguments(
    EMAIL_READ,
    "list",
    { action: "list", subject: "invoice", since: "2026-08-01" },
    true,
  );
  const note = buildIgnoredArgumentsNote("email_read", "list", review.ignoredMisplaced);
  for (const needle of ["email_read", "'list'", "'subject'", "'since'", "'search'", "not applied"]) {
    assert(note.includes(needle), `expected ${JSON.stringify(needle)} in ${JSON.stringify(note)}`);
  }
});

Deno.test("a note about one argument reads as one argument", () => {
  const note = buildIgnoredArgumentsNote("email_read", "list", [
    { property: "subject", owners: ["search"] },
  ]);
  assert(note.includes("It was not applied"), `singular phrasing: ${note}`);
  assert(!note.includes("They were"), `no plural leakage: ${note}`);
});

Deno.test("the note instructs the model to do nothing", () => {
  // Same doctrine as every other string this server puts in front of a model:
  // an imperative from inside a tool response is indistinguishable from the
  // operator injecting a prompt. State what happened.
  const note = buildIgnoredArgumentsNote("email_read", "search", [
    { property: "folder", owners: ["list"] },
    { property: "unread_only", owners: ["list"] },
  ]);
  for (const imperative of ["you should", "you must", "please ", "retry with", "use the", "instead use", "call the"]) {
    assert(
      !note.toLowerCase().includes(imperative),
      `note must not instruct the model (${imperative}): ${note}`,
    );
  }
});
