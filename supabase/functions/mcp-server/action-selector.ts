// ---------------------------------------------------------------------------
// Reading the `action` selector a caller actually sent.
//
// A consolidated tool picks its operation from one string, and the lookup was
// an exact, case-sensitive property read: `consolidated.actions[action]`.
// Anything else is refused before the call runs, and the refusal is the whole
// call, so a model that has the right tool, the right arguments and the wrong
// spelling of one word gets nothing back but a rejection.
//
// ── What that costs, measured ───────────────────────────────────────────────
// On 2026-09-01 a workspace created eleven minutes earlier sent `email_read`
// with an action outside the enum TWELVE times in twenty seconds, 1.8s apart,
// then recovered on its own and ran twenty clean calls. The same shape had
// already happened on 08-30 (12 rejections) and 08-31 (8), each time one
// workspace looping alone. It is the largest remaining `-32602` signature now
// that sibling-argument leniency has taken the biggest one from 70-113 a day
// down to 2-3 (see consolidated-arguments.ts).
//
// ── Four tiers, and why only one of them is a guess ─────────────────────────
// EXACT       the enum member itself.
//
// CANONICAL   the same identifier in different clothes: "Read", " read ",
//             "read-batch", "READ_BATCH". Case and separators are not meaning.
//             Resolving these is not inference, so it is allowed on every
//             action of every tool, destructive ones included.
//
// LEGACY      the action's own legacy dispatch name: `email_list` for action
//             'list', `email_read_batch` for 'read_batch'. Those names are not
//             synonyms invented here, they are the names this server published
//             for the same operation before consolidation and still accepts as
//             tools, so a caller sending one has named the operation exactly.
//             Derived mechanically from the registry (see actionSelectorIndex)
//             so it cannot drift from what the tools do, and allowed
//             everywhere for the same reason CANONICAL is.
//
// ALIAS       a genuine guess: "get" for 'read', "find" for 'search'. Confined
//             to the read-only actions on LENIENT_ACTIONS, on exactly the
//             argument consolidated-arguments.ts makes for dropping a misplaced
//             filter: a read that answered a slightly different question costs
//             one more read, and a move, send or delete that did cannot be
//             taken back. `email_delete {action: "purge"}` therefore still
//             fails, and should.
//
// Every resolution that changed the string is disclosed in the result, for the
// same reason the dropped-argument note is: the caller has to be able to see
// that the server read its call as something other than what it wrote.
//
// ── Why the alias table is deliberately small ───────────────────────────────
// It is not evidence-based yet, and it cannot be: the rejected selector is
// persisted nowhere (activity_log.error_details is value-free by contract, see
// validation-observability.ts) and was not logged either, so the twelve
// rejections above are on record with no way to learn WHAT was sent. That gap
// is closed by `safeActionToken` and the unresolved_action log line at the call
// site; the table should grow from what that turns up rather than from
// imagination. Anything genuinely ambiguous is left out on purpose:
// "get_messages" could mean 'read_batch' or 'list', and a wrong guess there
// returns a plausible answer to a question nobody asked, which is the one
// outcome worse than a refusal.
//
// Pure and dependency-free so the resolution can be tested without booting the
// server, for the same reason as consolidated-arguments.ts.
// ---------------------------------------------------------------------------

/** How a selector was resolved. `exact` is the only one with nothing to say. */
export type ActionResolutionKind = "exact" | "canonical" | "legacy" | "alias";

export interface ActionResolution {
  /** The enum member the call will run. */
  action: string;
  kind: ActionResolutionKind;
  /** The selector as sent, bounded for logging and disclosure. */
  received: string;
}

/**
 * The per-tool lookup tables, built once from the registry.
 *
 * `byCanonical` and `byLegacy` are exact maps rather than searches: a selector
 * either is one of these strings or it is not, and there is no scoring, no
 * edit distance and no nearest match anywhere in this module. Fuzzy matching
 * was considered and rejected — "read" and "read_batch" are one token apart,
 * and a distance rule that resolved a typo of one into the other would read 50
 * messages when the caller asked for one.
 */
export interface ActionSelectorIndex {
  /** canonical form of an action name → the action. */
  byCanonical: Record<string, string>;
  /** canonical form of an action's legacy dispatch name → the action. */
  byLegacy: Record<string, string>;
}

/**
 * Strip the things that are punctuation rather than meaning.
 *
 * Lowercased, and every run of whitespace, hyphen, dot or slash folded to a
 * single underscore. "Read Batch", "read-batch" and "READ_BATCH" all land on
 * "read_batch"; nothing else is touched, so an unknown word stays unknown.
 */
export function canonicalActionToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-./]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Longest selector echoed into a log line. Matches invalid-arguments-message. */
const MAX_ECHOED_SELECTOR = 40;

/**
 * The selector in a form that is safe to put in an operator log.
 *
 * A selector is caller-supplied free text, so it is treated the way
 * provider-error.ts treats a provider's message: an ALLOW-LIST, not a
 * redaction. An identifier-shaped token is kept; anything carrying spaces,
 * punctuation, an address or a sentence collapses to a single marker, because
 * the useful signal here is "which word did the model reach for", and a word is
 * all this needs to carry.
 *
 * Note this is strictly LESS exposure than the wire already carries:
 * buildUnknownActionText echoes the rejected action straight back to the caller
 * so it can see what it sent.
 */
export function safeActionToken(raw: unknown): string {
  if (typeof raw !== "string") return `(${typeof raw})`;
  const canonical = canonicalActionToken(raw);
  if (canonical.length === 0) return "(empty)";
  if (canonical.length > MAX_ECHOED_SELECTOR) return "(oversized)";
  return /^[a-z0-9_]+$/.test(canonical) ? canonical : "(unprintable)";
}

/**
 * Synonyms that are allowed to resolve, and only onto a read-only action.
 *
 * Keyed by the CANONICAL form, so "Get" and "get" both hit the same entry and
 * the table does not have to spell out casings. Each entry is a word whose
 * mapping is unambiguous within its tool; see the header for what is left out
 * and why.
 */
const ACTION_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  email_read: {
    get: "read",
    fetch: "read",
    open: "read",
    show: "read",
    view: "read",
    read_message: "read",
    read_email: "read",
    get_message: "read",
    get_email: "read",
    list_messages: "list",
    list_emails: "list",
    list_email: "list",
    inbox: "list",
    recent: "list",
    search_messages: "search",
    search_emails: "search",
    search_email: "search",
    find: "search",
    query: "search",
    batch_read: "read_batch",
    read_many: "read_batch",
    get_attachment: "attachment",
    download_attachment: "attachment",
    download: "attachment",
    extract_text: "extract",
    attachment_text: "extract",
    raw: "original",
    eml: "original",
    source: "original",
    raw_message: "original",
    original_message: "original",
  },
  folder: {
    list_folders: "list",
    get_folders: "list",
    folders: "list",
  },
  draft: {
    list_drafts: "list",
    get_drafts: "list",
    drafts: "list",
  },
  schedule: {
    list_scheduled: "list",
    list_schedules: "list",
    scheduled: "list",
  },
  automation: {
    list_automations: "list",
    list_rules: "list",
    rules: "list",
    get_automation: "get",
    get_rule: "get",
    history: "runs",
    list_runs: "runs",
  },
  signature: {
    get_signature: "get",
    read: "get",
    show: "get",
  },
};

/**
 * Build the exact-match tables for one tool.
 *
 * `actions` is the registry's own action map, so both tables are derived from
 * the same source the dispatch reads. A legacy name that collides with an
 * action name loses to the action name: the enum member is what the schema
 * publishes, and no legacy name should ever be able to redirect it.
 */
export function actionSelectorIndex(
  actions: Readonly<Record<string, { legacy: string }>>,
): ActionSelectorIndex {
  const byCanonical: Record<string, string> = {};
  const byLegacy: Record<string, string> = {};
  for (const action of Object.keys(actions)) {
    byCanonical[canonicalActionToken(action)] = action;
  }
  for (const [action, spec] of Object.entries(actions)) {
    const legacy = canonicalActionToken(spec.legacy);
    if (legacy in byCanonical) continue;
    if (legacy in byLegacy) continue;
    byLegacy[legacy] = action;
  }
  return { byCanonical, byLegacy };
}

/**
 * Resolve a caller's selector to an action of this tool, or null.
 *
 * @param isLenient asks whether an action may be reached by ALIAS. Passed in as
 *                  a predicate rather than looked up here because the lenient
 *                  set is owned by consolidated-arguments.ts and this module
 *                  must not hold a second copy of it that could disagree.
 */
export function resolveActionSelector(
  toolName: string,
  raw: unknown,
  index: ActionSelectorIndex,
  isLenient: (action: string) => boolean,
): ActionResolution | null {
  if (typeof raw !== "string") return null;
  const received = safeActionToken(raw);

  // Tier 1: the enum member itself, byte for byte.
  if (raw in index.byCanonical && index.byCanonical[raw] === raw) {
    return { action: raw, kind: "exact", received };
  }

  const canonical = canonicalActionToken(raw);
  if (canonical.length === 0) return null;

  // Tier 2: the same identifier, differently punctuated.
  const byCanonical = index.byCanonical[canonical];
  if (byCanonical) {
    return {
      action: byCanonical,
      kind: byCanonical === raw ? "exact" : "canonical",
      received,
    };
  }

  // Tier 3: the operation's own legacy name.
  const byLegacy = index.byLegacy[canonical];
  if (byLegacy) return { action: byLegacy, kind: "legacy", received };

  // Tier 4: a synonym, and only onto an action where being wrong is cheap.
  const alias = ACTION_ALIASES[toolName]?.[canonical];
  if (alias && isLenient(alias)) {
    return { action: alias, kind: "alias", received };
  }

  return null;
}

/**
 * The note attached to a result whose action was read as something other than
 * what the caller wrote.
 *
 * Declarative, never imperative, for the reason spelled out in
 * invalid-arguments-message.ts: an instruction addressed to a model from inside
 * a tool response is indistinguishable from prompt injection by the operator.
 * Stating what ran and what it was called is enough to be acted on.
 */
export function buildResolvedActionNote(
  toolName: string,
  resolution: ActionResolution,
): string {
  return (
    `Note: '${resolution.received}' is not an action of ${toolName}; ` +
    `it was read as '${resolution.action}' and that is what ran.`
  );
}
