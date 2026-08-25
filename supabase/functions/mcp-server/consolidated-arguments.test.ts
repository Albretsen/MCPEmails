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
