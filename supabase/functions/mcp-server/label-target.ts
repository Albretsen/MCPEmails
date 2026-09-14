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
//
// ── WHITESPACE (2026-09-14) ────────────────────────────────────────────────
// This is the ONE place that may trim a folder value, and it trims the caller's
// value and the candidate names TOGETHER or not at all. Until now it trimmed
// only the caller's side, which made any mailbox whose name carries leading or
// trailing spaces - " LM1921 & LM1935 ", created in a provider's own web UI,
// reported by LIST with its spaces intact, and on IMAP its own id - permanently
// unaddressable: `f.id === trimmed` could not match because the id still had
// the spaces, `f.name.toLowerCase() === lower` could not match for the same
// reason, and no spelling the caller could type would ever reach it. A user
// could not even move mail OUT of such a folder.
//
// resolveFolderId in index.ts used to trim as well, one layer up, which meant
// the raw value never even arrived here. It no longer does: the caller's value
// reaches this function exactly as the agent typed it, and every trimming
// decision is taken below. Two layers cannot both own this rule.
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
  | { ok: true; id: string; matched: "id" | "name" | "alias" | "whitespace" }
  | {
    ok: false;
    code: "folder_required" | "folder_not_found" | "folder_ambiguous";
    error: string;
  };

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
 * A folder-taking argument as the matcher should receive it: present-checked,
 * never edited.
 *
 * Every move/copy handler used to write `args["destination_folder_id"].trim()`
 * and carry the TRIMMED value forward, which made the tool handlers a third
 * layer with an opinion about whitespace, after resolveFolderId and
 * resolveFolderReference. It was also the layer that mattered most: a mailbox
 * named " LM1921 & LM1935 " in a provider's web UI is addressed by exactly
 * those spaces, and that line removed them before the matcher was ever
 * consulted, so the user's actual complaint - that mail could not be moved into
 * or out of such a folder - would have survived any fix made further down.
 *
 * The trim stays where it belongs, in the PRESENCE test: an argument of nothing
 * but whitespace is still absent, and the caller still gets "required and must
 * be a non-empty string", exactly as before. What comes back is the caller's
 * string, untouched, for {@link resolveFolderReference} to decide about. It is
 * also what the result echoes, so the agent is told the destination it asked
 * for rather than a cleaned-up version of it.
 */
export function folderArgumentValue(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim() ? raw : "";
}

/** A folder name a caller asked to CREATE or RENAME to, and what it became. */
export interface FolderNameRequest {
  /** What will actually be written. Empty when the request was blank. */
  name: string;
  /** Exactly what the caller typed. */
  requested: string;
  /** True when the two differ, i.e. whitespace was removed. */
  trimmed: boolean;
}

/**
 * The name a folder will actually get, and whether that differs from the ask.
 *
 * THE TRIM STAYS, AND IT IS NOT SILENT. Two defensible answers exist for
 * `folder action: create` with " ZZ SPACE TEST ": honour the spaces, or refuse
 * the name. Honouring them manufactures exactly the mailbox this file's
 * addressing section exists to rescue people from - one that is awkward in
 * every mail client the user owns, not merely in this connector - and an agent
 * that emits a stray space around a folder name is doing it by accident
 * essentially always. Refusing outright would fail a routine call over a
 * character nobody meant to type.
 *
 * So the name is trimmed, and the trim is REPORTED. That is the same rule this
 * module's header states for labels, and the third option was never "trim it
 * quietly": until 2026-09-14 create answered with a folder called
 * "ZZ SPACE TEST" and said nothing, so the agent kept the padded spelling in
 * its head and every later call to it looked like a not-found. A transformation
 * the caller is not told about is a bug with a delay on it.
 */
export function folderNameRequest(raw: unknown): FolderNameRequest {
  const requested = typeof raw === "string" ? raw : "";
  const name = requested.trim();
  return { name, requested, trimmed: name !== requested };
}

/**
 * The sentence that tells a caller their folder is not called what they asked.
 *
 * Null when nothing changed, so the caller can spread it into a result without
 * deciding anything. It names both spellings and says which one to use next,
 * because "whitespace was removed" without the resulting name is a warning the
 * agent cannot act on.
 */
export function folderNameTrimNote(
  req: FolderNameRequest,
  noun: "folder" | "label" = "folder",
): string | null {
  if (!req.trimmed || !req.name) return null;
  return (
    `Leading or trailing whitespace was removed from the requested name, so ` +
    `this ${noun} is called "${req.name}", not "${req.requested}". Address it ` +
    `by that name from now on.`
  );
}

/**
 * The message an agent gets when a value matches two folders that differ only
 * in the whitespace around their names.
 *
 * Spelled out with the padding visible inside the quotes, because that is the
 * only thing that tells the two apart and the whole point of the refusal is
 * that the caller must choose between them.
 */
function folderAmbiguousMessage(
  value: string,
  candidates: readonly FolderReference[],
  ctx: FolderResolutionContext = {},
): string {
  const noun = folderNoun(ctx);
  const names = candidates.map((f) => `"${f.name}"`).join(" and ");
  return (
    `"${value}" matches ${candidates.length} ${noun}s in this inbox once ` +
    `surrounding whitespace is ignored: ${names}. They differ only in the ` +
    `spaces around the name, so there is no way to tell which one was meant. ` +
    `Reissue the call with the ${noun} spelled EXACTLY as it appears above, ` +
    `including its leading and trailing spaces, or pass its id from ` +
    `folder action: list. Nothing was changed.`
  );
}

/**
 * The EXACT half of {@link resolveFolderReference}: a provider id compared
 * byte for byte, then a display name compared case-insensitively, both on the
 * value AS THE CALLER TYPED IT. Null when neither hits.
 *
 * It is exported, and it is the reason this is a function rather than four
 * lines inside the matcher, because a SECOND caller has to ask this exact
 * question FIRST: `resolveFolderId` in index.ts reads some values as an alias
 * ROLE ("spam" → whichever mailbox the server flags \\Junk), and a role reading
 * must never outvote a folder that literally bears the name that was typed.
 *
 * ── The bug that moved this up here (2026-09-14) ───────────────────────────
 * `resolveFolderId` matched the alias table first and RETURNED on a hit, so
 * step 3 below was unreachable for any value that happened to be an alias
 * token. On a Migadu account holding both a "Junk" and a "Spam" mailbox,
 * `email_read action: list folder: "Spam"` listed Junk, and
 * `email_organize action: copy destination_folder_id: "Spam"` reported success
 * and put the message in Junk. That is a silent wrong-folder WRITE, which is
 * strictly worse than the "Mailbox not found" the same alias table produced on
 * the read paths, because nothing in the response says it happened.
 *
 * One rule, one implementation: whoever types a folder's exact name gets that
 * folder, and an alias is consulted only for a value no folder answers to.
 */
export function matchFolderExactly(
  value: string,
  folders: readonly FolderReference[],
): FolderReference | null {
  const byId = folders.find((f) => f.id === value);
  if (byId) return byId;
  const lower = value.toLowerCase();
  return folders.find((f) => f.name.toLowerCase() === lower) ?? null;
}

/**
 * Matches a user-supplied folder value against a folder listing.
 *
 * Order (the first three are what the move path has always done, which is the
 * point; the fourth is the 2026-09-14 whitespace fix described at the top of
 * this section):
 *   1. exact provider id, on the value EXACTLY as the caller typed it;
 *   2. display name, case-insensitively, likewise untrimmed;
 *   3. the canonical names of an alias the caller already matched;
 *   4. whitespace-insensitive: the caller's value and each candidate id/name
 *      trimmed on BOTH sides before comparing, which is how " LM1921 & LM1935 "
 *      becomes reachable and how "  Archive  " keeps working;
 *   5. nothing -> a STRUCTURED failure, never a throw and never a silent
 *      pass-through of the unmatched value to the provider.
 *
 * ── WHY EXACT COMES FIRST, AND WHY AMBIGUITY REFUSES ────────────────────────
 * A mailbox " Work " and a mailbox "Work" can both exist; providers allow it
 * and one user already has the shape. Whoever types either name exactly gets
 * that exact mailbox, every time, from steps 1-2 - an exact match can never be
 * outvoted by a fuzzy one. Only a spelling that is exact for NEITHER (say
 * "  Work  ", a third padding) reaches step 4, and there the honest answer is
 * that we do not know which was meant.
 *
 * So step 4 resolves only when the relaxed match is UNIQUE, and refuses with
 * `folder_ambiguous` when it is not. Guessing here would move mail into the
 * wrong mailbox and report success, and a move an agent believes succeeded is
 * a move nobody goes looking for. A refusal that names both candidates with
 * their padding visible costs one round trip and cannot lose mail.
 */
export function resolveFolderReference(
  value: string,
  folders: readonly FolderReference[],
  ctx: FolderResolutionContext = {},
): FolderResolution {
  const trimmed = value.trim();
  // A value that is nothing but whitespace scopes nothing. A mailbox named
  // only of spaces is theoretically expressible and deliberately NOT reachable
  // here: "pass a folder" is the more useful answer to a blank argument than
  // an exotic match, and index.ts refuses the blank one layer earlier anyway.
  if (!trimmed) {
    return {
      ok: false,
      code: "folder_required",
      error: `A ${folderNoun(ctx)} is required: pass an id, a name, or one of the ` +
        `aliases ${FOLDER_ALIAS_TOKENS.join(", ")}.`,
    };
  }

  // ── 1-2: exact, on the value as typed ─────────────────────────────────────
  const exact = matchFolderExactly(value, folders);
  if (exact) {
    return { ok: true, id: exact.id, matched: exact.id === value ? "id" : "name" };
  }

  const lower = trimmed.toLowerCase();

  // ── 3: alias, before the relaxed pass, NOT after ───────────────────────────
  // An alias is a request for a ROLE ("trash"), and a user folder that happens
  // to be named " trash " is not that role. Running the alias first keeps the
  // real Trash winning over a padded lookalike.
  const aliasNames = (ctx.aliasNames ?? []).map((a) => a.toLowerCase());
  if (aliasNames.length > 0) {
    const byAlias = folders.find((f) => aliasNames.includes(f.name.toLowerCase()));
    if (byAlias) return { ok: true, id: byAlias.id, matched: "alias" };
  }

  // ── 4: whitespace-insensitive, both sides trimmed, unique or nothing ───────
  // Deduplicated by id because on IMAP the name IS the id, so one mailbox
  // satisfies both comparisons and must not look like two candidates.
  const relaxed: FolderReference[] = [];
  for (const f of folders) {
    const hit = f.id.trim() === trimmed || f.name.trim().toLowerCase() === lower;
    if (hit && !relaxed.some((r) => r.id === f.id)) relaxed.push(f);
  }
  if (relaxed.length === 1) {
    return { ok: true, id: relaxed[0].id, matched: "whitespace" };
  }
  if (relaxed.length > 1) {
    return {
      ok: false,
      code: "folder_ambiguous",
      error: folderAmbiguousMessage(value, relaxed, ctx),
    };
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
