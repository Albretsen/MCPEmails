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

/** One rewrite that was applied, for the operator log. Names only, no values. */
export interface AppliedArgumentAlias {
  from: string;
  to: string;
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
  const rules = ARGUMENT_ALIASES[toolName];
  if (!rules) return [];
  const applied: AppliedArgumentAlias[] = [];
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
  return (ARGUMENT_ALIASES[toolName] ?? []).map((rule) => rule.from);
}
