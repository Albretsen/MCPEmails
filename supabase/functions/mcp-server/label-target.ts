// ---------------------------------------------------------------------------
// label-target.ts - what "apply a label" means on each provider.
//
// "Label" is one idea with three provider-native spellings, and only one of
// them has naming rules strict enough to be worth enforcing before a mailbox is
// touched:
//
//   gmail   -> a LABEL.    Free-form text. Resolved to (or created as) a label id.
//   outlook -> a CATEGORY. Free-form text, held in the message's `categories` array.
//   imap    -> a KEYWORD.  An IMAP atom, so a constrained ASCII token.
//
// Everything in this module is PURE: no I/O, no provider clients, no imports.
// That is what lets the three callers share one answer instead of three
// almost-agreeing ones:
//
//   * index.ts, which makes the actual provider call (`applyLabelToMessage`);
//   * triage-engine.ts, which refuses a rule that could never work at the moment
//     it is written rather than five minutes later in a run log;
//   * apps/web/src/lib/automations/rules.ts, which mirrors it for the dashboard.
//
// The rule this module exists to hold: a transformed name is REPORTED, never
// applied silently. If the mailbox ends up with "Order_updates" the user must be
// told that, or the mailbox and the dashboard disagree about what was done.
// ---------------------------------------------------------------------------

/** The provider-native thing a label becomes. */
export type LabelTargetKind = "label" | "category" | "keyword";

export interface LabelTarget {
  kind: LabelTargetKind;
  /** Exactly what will be written to the mailbox. */
  applied_as: string;
  /** True when `applied_as` differs from what the user typed. */
  transformed: boolean;
}

export type LabelTargetResult =
  | { ok: true; target: LabelTarget }
  | { ok: false; error: string };

/**
 * Keyword length ceiling.
 *
 * RFC 3501 sets none, which is exactly why one is needed here: servers pick
 * their own, and discovering a server's limit by having a STORE rejected
 * mid-run is the failure mode this module exists to prevent. 64 is comfortably
 * under every limit we have seen and still longer than any label a person types.
 */
export const MAX_IMAP_KEYWORD_CHARS = 64;

/**
 * Characters an IMAP keyword may not contain.
 *
 * RFC 3501's flag-keyword is an `atom`, and atom-specials are `(`, `)`, `{`,
 * SP, CTL, the list-wildcards `%` and `*`, the quoted-specials `"` and `\`, and
 * the resp-special `]`. `[` is technically legal in an atom; it is refused here
 * anyway, deliberately stricter than the RFC, because a name of the form
 * "[Work]" round-trips badly through enough servers that allowing half of a
 * bracket pair buys nothing.
 */
const IMAP_KEYWORD_ILLEGAL_RE = /[()[\]{}%*"\\]/;

/** Anything outside printable ASCII, checked after whitespace has been folded. */
const IMAP_KEYWORD_NON_ATOM_RE = /[^\x21-\x7e]/;

/** The illegal set, spelled out for an error a user can act on. */
const IMAP_KEYWORD_ILLEGAL_LIST = '( ) [ ] { } % * " \\';

/**
 * Normalises a human label into a legal IMAP keyword, or refuses it.
 *
 * THE ONE TRANSFORMATION: runs of whitespace become a single underscore, so
 * "Order updates" is applied as "Order_updates". Spaces are the single most
 * common thing in a label and the single thing an IMAP atom cannot hold, and
 * refusing every multi-word label would make the action useless on 110 of the
 * 163 connected inboxes. Every caller reports `applied_as` when `transformed`
 * is set, so the mailbox never quietly disagrees with the UI.
 *
 * NOTHING ELSE is transformed. An illegal character is an error, not a silent
 * substitution: a user who typed "Sale (50%)" wants to know their label was
 * refused, not to find "Sale_50" in their mailbox.
 */
export function normalizeImapKeyword(label: string): LabelTargetResult {
  const raw = label.trim();
  if (!raw) {
    return { ok: false, error: "A label is required." };
  }
  // Fold whitespace FIRST, so the checks below see the string that will
  // actually be sent rather than the one that was typed.
  const keyword = raw.replace(/\s+/g, "_");
  const transformed = keyword !== raw;

  if (keyword.startsWith("\\")) {
    return {
      ok: false,
      error:
        `On an IMAP mailbox a label is stored as an IMAP keyword, and a keyword cannot ` +
        `begin with a backslash: that namespace is reserved for system flags such as ` +
        `\\Seen and \\Flagged. Rename "${raw}" without the leading backslash.`,
    };
  }
  if (IMAP_KEYWORD_ILLEGAL_RE.test(keyword)) {
    return {
      ok: false,
      error:
        `On an IMAP mailbox a label is stored as an IMAP keyword, which cannot contain ` +
        `${IMAP_KEYWORD_ILLEGAL_LIST}. Rename "${raw}" without those characters, or use a ` +
        `move action to file the mail in a folder instead.`,
    };
  }
  if (IMAP_KEYWORD_NON_ATOM_RE.test(keyword)) {
    return {
      ok: false,
      error:
        `On an IMAP mailbox a label is stored as an IMAP keyword, which is limited to ` +
        `printable ASCII by the IMAP protocol. Rename "${raw}" using ASCII letters, ` +
        `digits, - or _, or use a move action to file the mail in a folder instead: ` +
        `folder names have no such limit.`,
    };
  }
  if (keyword.length > MAX_IMAP_KEYWORD_CHARS) {
    return {
      ok: false,
      error:
        `On an IMAP mailbox a label is stored as an IMAP keyword, which must be at most ` +
        `${MAX_IMAP_KEYWORD_CHARS} characters. "${raw}" is longer than that.`,
    };
  }
  return { ok: true, target: { kind: "keyword", applied_as: keyword, transformed } };
}

/**
 * Resolves what a label becomes on one provider.
 *
 * `provider` follows the house convention: every IMAP service is stored as
 * "imap" with a `service` discriminator, so IMAP is the `default` branch and a
 * provider nobody has heard of is treated as IMAP rather than waved through.
 * A null provider (the caller could not determine one) is treated as Gmail-shaped,
 * i.e. unconstrained, because refusing a legal label on an unknown provider is
 * the worse error: the provider seam validates again before it writes anything.
 */
export function labelTargetFor(provider: string | null, label: string): LabelTargetResult {
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "A label is required." };
  switch (provider) {
    case null:
    case "gmail":
      return { ok: true, target: { kind: "label", applied_as: trimmed, transformed: false } };
    case "outlook":
      return { ok: true, target: { kind: "category", applied_as: trimmed, transformed: false } };
    default:
      return normalizeImapKeyword(trimmed);
  }
}

/** The provider-native noun, for copy that has to name the thing. */
export function labelTargetKindFor(provider: string | null): LabelTargetKind {
  switch (provider) {
    case null:
    case "gmail":
      return "label";
    case "outlook":
      return "category";
    default:
      return "keyword";
  }
}

/**
 * Merges one category into a message's existing `categories`.
 *
 * THIS IS THE DATA-LOSS GUARD. Graph treats `categories` as a REPLACE: a PATCH
 * carrying `["Receipts"]` does not add "Receipts", it makes "Receipts" the only
 * category the message has, silently discarding whatever the user had already
 * filed it under. Every write therefore has to read first and merge, and the
 * merge lives here, as a pure function, so it is directly testable rather than
 * buried in a fetch.
 *
 * Comparison is case-insensitive because Outlook's own category list is, and
 * an existing "receipts" is left with its existing casing rather than being
 * rewritten to match what the rule happens to have typed. `changed:false` means
 * the caller must skip the PATCH entirely: there is nothing to add, and a
 * no-op PATCH is still a write that can fail.
 */
export function mergeOutlookCategories(
  existing: readonly string[],
  category: string,
): { categories: string[]; changed: boolean } {
  const clean = existing.filter((c) => typeof c === "string" && c.length > 0);
  const lowered = category.toLowerCase();
  if (clean.some((c) => c.toLowerCase() === lowered)) {
    return { categories: [...clean], changed: false };
  }
  return { categories: [...clean, category], changed: true };
}

/**
 * Whether a mailbox's PERMANENTFLAGS permit a custom keyword.
 *
 * `\*` in PERMANENTFLAGS is the server saying "you may invent keywords here"
 * (RFC 3501 section 7.1). A server that lists the keyword itself also permits
 * it, which is how a mailbox with a fixed, pre-provisioned keyword set answers.
 * `null` in, `null` out: a server that sent no PERMANENTFLAGS at all has told us
 * nothing, and the RFC's guidance in that case is to assume flags are permanent,
 * so the caller attempts the STORE and treats a rejection as the real answer.
 */
export function permanentFlagsAllowKeyword(
  permanentFlags: readonly string[] | null,
  keyword: string,
): boolean | null {
  if (!permanentFlags) return null;
  if (permanentFlags.some((f) => f === "\\*")) return true;
  const lowered = keyword.toLowerCase();
  return permanentFlags.some((f) => f.toLowerCase() === lowered);
}

// ---------------------------------------------------------------------------
// Folder / label ADDRESSING
//
// The other half of the same idea: not "what does a label become on this
// provider", but "which existing folder did the caller mean". Every
// folder-taking argument in the connector (`email_read action:list`'s `folder`,
// `email_read action:search`'s `include_folders`, `email_organize`'s
// `destination_folder_id`) documents the same three spellings - a provider id,
// a display name, or one of the aliases below - and before this section only
// the move path honoured all three. `email_read action:list` demanded the raw
// provider id, so an agent that created "Receipts" by name and then tried to
// list it dead-ended on Gmail's "Invalid label: Receipts".
//
// So the matching rule lives here, pure and shared, and the callers differ only
// in WHERE the folder listing comes from. Case-insensitive on names, because
// that is what the move path has always done and one behaviour is worth more
// than the marginally stricter one.
// ---------------------------------------------------------------------------

/** One folder (Gmail: label) as `folder action: list` reports it. */
export interface FolderReference {
  /** Provider-native id. On IMAP the mailbox name IS the id. */
  id: string;
  /** Display name. */
  name: string;
}

/** The aliases every folder argument accepts, in the order the tool docs list them. */
export const FOLDER_ALIAS_TOKENS = [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "archive",
  "spam",
] as const;

export type FolderResolution =
  | { ok: true; id: string; matched: "id" | "name" | "alias" }
  | { ok: false; code: "folder_required" | "folder_not_found"; error: string };

export interface FolderResolutionContext {
  /**
   * Canonical names an already-matched alias may wear in the listing (e.g. the
   * alias "trash" against a mailbox literally named "Trash"). Supplied by the
   * caller because the alias table is provider vocabulary, not matching logic.
   */
  aliasNames?: readonly string[];
  /** Provider slug, for copy that names it ("this gmail inbox"). */
  provider?: string | null;
  /** What the provider calls the thing. Defaults to the Gmail/other split. */
  itemNoun?: "folder" | "label";
  /** One extra sentence appended before the "call folder action: list" nudge. */
  hint?: string | null;
  /**
   * The names this mailbox actually has, to be listed in a not-found message.
   *
   * Supplied by resolveFolderReference, which has just searched them, so the
   * remedy arrives with the failure instead of one round trip later. Left
   * unset by the call sites that raise a not-found without a listing in hand
   * (an alias with no candidate mailbox), where the pointer at `folder action:
   * list` is still the only honest thing to say.
   */
  available?: readonly string[];
}

/** What the provider calls its organisation primitive. */
function folderNoun(ctx: FolderResolutionContext): "folder" | "label" {
  return ctx.itemNoun ?? (ctx.provider === "gmail" ? "label" : "folder");
}

/**
 * How many mailbox names a not-found message will spell out.
 *
 * Sized to be the answer rather than a sample: the mailboxes in production sit
 * well under this, and a caller with more than forty folders is one whose
 * message would stop being readable long before it stopped being complete. The
 * count of the remainder is still stated, so a truncated list never reads as
 * the whole mailbox.
 */
const MAX_LISTED_FOLDERS = 40;

/**
 * The names this mailbox actually has, when the caller handed them over.
 *
 * This is the sentence that turns a permanent naming mismatch from a round
 * trip into an answer. `folder_not_found` on the read paths ran 18 times in the
 * week to 2026-09-01 across nine workspaces, every one of them a model guessing
 * a name ("Junk", "Archive") that this inbox does not use; the listing was
 * already in memory at the point of failure and was thrown away.
 *
 * Folder names are the caller's own mailbox, returned to the authenticated
 * caller who can list them with one call anyway, so naming them here discloses
 * nothing new. Empty when there is nothing to name, which keeps the message
 * identical to what it was for the call sites that have no listing.
 */
function availableClause(ctx: FolderResolutionContext): string {
  const available = (ctx.available ?? []).filter((name) => name.trim().length > 0);
  if (available.length === 0) return "";
  const noun = folderNoun(ctx);
  const listed = available.slice(0, MAX_LISTED_FOLDERS);
  const omitted = available.length - listed.length;
  const names = listed.map((name) => `"${name}"`).join(", ");
  return (
    `This inbox has ${available.length} ${noun}${available.length === 1 ? "" : "s"}: ` +
    `${names}${omitted > 0 ? `, and ${omitted} more` : ""}. `
  );
}

/**
 * The message an agent gets when a folder value matches nothing.
 *
 * THE POINT OF THIS FUNCTION is what it does NOT say. The old path ended in
 * "Provider error while listing inbox: Gmail API error: Invalid label: X.
 * Please try again in a moment." - a permanent naming mismatch dressed up as a
 * transient fault, so the agent retried a call that could never work. This one
 * names the value, names the three accepted spellings, points at the call that
 * lists them, and says plainly that waiting will not help.
 */
export function folderNotFoundMessage(
  value: string,
  ctx: FolderResolutionContext = {},
): string {
  const noun = folderNoun(ctx);
  const where = ctx.provider ? `this ${ctx.provider} inbox` : "this inbox";
  return (
    `No ${noun} matching "${value}" exists in ${where}. ` +
    `A folder argument accepts a ${noun} id, the exact ${noun} name ` +
    `(case-insensitive), or one of the aliases ${FOLDER_ALIAS_TOKENS.join(", ")}. ` +
    (ctx.hint ? `${ctx.hint} ` : "") +
    availableClause(ctx) +
    `Call folder action: list on this inbox to see the ids and names it actually has, ` +
    `then reissue the call with one of them. This is a permanent naming mismatch, ` +
    `not a temporary fault: the same value will keep failing until it changes.`
  );
}

/**
 * Matches a user-supplied folder value against a folder listing.
 *
 * Order (identical to what the move path has always done, which is the point):
 *   1. exact provider id;
 *   2. display name, case-insensitively;
 *   3. the canonical names of an alias the caller already matched;
 *   4. nothing -> a STRUCTURED failure, never a throw and never a silent
 *      pass-through of the unmatched value to the provider.
 */
export function resolveFolderReference(
  value: string,
  folders: readonly FolderReference[],
  ctx: FolderResolutionContext = {},
): FolderResolution {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "folder_required",
      error: `A ${folderNoun(ctx)} is required: pass an id, a name, or one of the ` +
        `aliases ${FOLDER_ALIAS_TOKENS.join(", ")}.`,
    };
  }

  const byId = folders.find((f) => f.id === trimmed);
  if (byId) return { ok: true, id: byId.id, matched: "id" };

  const lower = trimmed.toLowerCase();
  const byName = folders.find((f) => f.name.toLowerCase() === lower);
  if (byName) return { ok: true, id: byName.id, matched: "name" };

  const aliasNames = (ctx.aliasNames ?? []).map((a) => a.toLowerCase());
  if (aliasNames.length > 0) {
    const byAlias = folders.find((f) => aliasNames.includes(f.name.toLowerCase()));
    if (byAlias) return { ok: true, id: byAlias.id, matched: "alias" };
  }

  return {
    ok: false,
    code: "folder_not_found",
    // The listing that was just searched goes into the message. It is the one
    // place in this function that knows both what was asked for and what is
    // there, and a failure that names only the first is half an answer.
    error: folderNotFoundMessage(trimmed, {
      ...ctx,
      available: folders.map((f) => f.name),
    }),
  };
}
