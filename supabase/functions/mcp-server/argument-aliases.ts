// ---------------------------------------------------------------------------
// Retired argument names that are still accepted on the wire.
//
// Until 2026-09-08 email_read advertised BOTH `unread_only` (the list action's
// boolean) and `unread` (the search action's tri-state), and schedule
// advertised both `id` and `scheduled_send_id` for the same value. Two names
// for one thing is exactly the overlap directory graders penalise and models
// trip on, so the published schemas now carry one canonical name each:
// `unread` and `id`.
//
// The old names cannot simply vanish, because MCP clients cache tools/list for
// the life of a connection and some hosts cache it far longer. A client
// holding last week's schema will keep sending `unread_only: true`, and with
// `additionalProperties: false` on every tool that call would be refused as an
// unknown property. So the retired names are rewritten into the canonical
// ones here, in place, BEFORE action resolution, the sibling-argument review
// and schema validation run, all of which read the same arguments object.
//
// The mapping is value-aware where the semantics differ: `unread_only: false`
// meant "no filter", which in the tri-state is the ABSENCE of `unread`, not
// `unread: false` (that would mean "read mail only"). Getting that wrong would
// silently hand a caller the opposite of what it asked for.
//
// Pure and dependency-free so it can be tested without booting the server.
// ---------------------------------------------------------------------------

/**
 * One rewrite that was applied, for the operator log. Names only, no values.
 *
 * `to` is null when the retired name was DROPPED rather than renamed: the
 * capability behind it is gone, so there is nothing to carry the value into.
 */
export interface AppliedArgumentAlias {
  from: string;
  to: string | null;
}

type AliasRule = {
  /** The retired name. */
  from: string;
  /** The canonical name it maps to. */
  to: string;
  /**
   * Translate the retired value into the canonical one. Returning `undefined`
   * means "the retired value asserted nothing; write no canonical value".
   */
  translate: (value: unknown) => unknown;
};

/**
 * Retired argument names with NO canonical replacement.
 *
 * `email_read.mark_as_read` wrote the \Seen flag at the provider after a
 * fetch. It was removed on 2026-09-16, not renamed: a tool that publishes
 * `readOnlyHint: true` must not be able to change anything, and the OpenAI
 * plugin review rejects exactly that mismatch ("set readOnlyHint to false if
 * the tool can ... change state ... even in only select modes, through default
 * parameters"). Flipping the hint instead would have made every read of a
 * mailbox a state-changing call in every client that gates on it. Marking read
 * lives on `email_organize { action: "flag", flag: "read" }`, which is
 * annotated as the write it is.
 *
 * Dropped here, before validation, for the same caching reason the renames
 * exist: `additionalProperties: false` would otherwise refuse the call of
 * every client still holding the old schema. The caller is told in a result
 * note (index.ts) rather than silently having its request narrowed.
 */
const DROPPED_ARGUMENTS: Record<string, readonly string[]> = {
  email_read: ["mark_as_read"],
};

const ARGUMENT_ALIASES: Record<string, readonly AliasRule[]> = {
  email_read: [
    {
      from: "unread_only",
      to: "unread",
      // true → unread only. false (the old default, "no filter") → omit. Any
      // other value is not a boolean and is carried over so the validator
      // still refuses it under the canonical name.
      translate: (value) => value === false ? undefined : value,
    },
  ],
  schedule: [
    { from: "scheduled_send_id", to: "id", translate: (value) => value },
  ],
};

/**
 * Rewrite retired argument names into their canonical names, in place.
 *
 * The canonical name always wins when both are present: a caller that sends
 * both is either following the new schema and has a stray old key, or is
 * confused, and in neither case should the old key override the new one. The
 * retired key is deleted either way so nothing downstream ever sees it.
 *
 * Returns the rewrites that were applied, for logging; an empty array means
 * the arguments were untouched.
 */
export function normalizeArgumentAliases(
  toolName: string,
  args: Record<string, unknown>,
): AppliedArgumentAlias[] {
  const applied: AppliedArgumentAlias[] = [];
  for (const name of DROPPED_ARGUMENTS[toolName] ?? []) {
    if (!(name in args)) continue;
    delete args[name];
    applied.push({ from: name, to: null });
  }
  const rules = ARGUMENT_ALIASES[toolName];
  if (!rules) return applied;
  for (const rule of rules) {
    if (!(rule.from in args)) continue;
    const retiredValue = args[rule.from];
    delete args[rule.from];
    applied.push({ from: rule.from, to: rule.to });
    if (rule.to in args) continue; // canonical name present: it wins
    const canonical = rule.translate(retiredValue);
    if (canonical !== undefined) args[rule.to] = canonical;
  }
  return applied;
}

/** The retired names a tool still accepts, for tests and documentation. */
export function retiredArgumentNames(toolName: string): string[] {
  return [
    ...(ARGUMENT_ALIASES[toolName] ?? []).map((rule) => rule.from),
    ...(DROPPED_ARGUMENTS[toolName] ?? []),
  ];
}

/** The retired names a tool accepts and then ignores. */
export function droppedArgumentNames(toolName: string): string[] {
  return [...(DROPPED_ARGUMENTS[toolName] ?? [])];
}
