// ---------------------------------------------------------------------------
// The advertised input schema: what `tools/list` says versus what we validate.
//
// A consolidated tool's full input schema carries an `allOf` of if/then/not
// rules, one per action, that name the action's required arguments and forbid
// the arguments of its sibling actions. The server-side Draft-7 validator in
// index.ts needs those rules; the argument-classification layer
// (consolidated-arguments.ts, action-selector.ts, argument-aliases.ts) is
// derived from the same merge. None of that changes here.
//
// Clients, however, are a different audience:
//
//   • Measured on 2026-09-08 the rules were 16.9 KB of a 73.4 KB `tools/list`
//     (23%), paid on every session of every client, for 17 tools.
//   • The Claude connector flattens `allOf` into one note reading "Input
//     constraint: all listed parameters apply together", which INVERTS the
//     rules' meaning (they say which parameters do NOT apply together).
//   • Other clients drop conditional keywords on the floor.
//
// So `tools/list` publishes the schema WITHOUT the rules, and the information
// the rules carried that a model can actually use, the required arguments per
// action, is stated in prose on the `action` selector's description instead,
// where a model that has not yet chosen an action is already reading. Both
// halves are generated from the same per-action `required` lists, so the prose
// cannot describe a contract other than the one the validator enforces.
//
// Nothing about server behaviour changes: a call is still validated against
// the full schema, and a misplaced argument is still classified and reported
// exactly as before.
// ---------------------------------------------------------------------------

/**
 * The copy of an input schema that `tools/list` advertises: identical to the
 * full schema except that the action-specific `allOf` rules are omitted.
 *
 * Returns the very same object when there is nothing to strip, so a tool that
 * never had rules (inbox_list, contact_search, the approval_* and bulk_*
 * tools) serialises byte-identically to before. When there is, the input is
 * left untouched: a shallow copy without the key is returned, and the registry
 * entry the validator reads keeps its rules.
 */
export function advertisedInputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!("allOf" in schema)) return schema;
  const { allOf: _rules, ...advertised } = schema;
  return advertised;
}

/** One action of a consolidated tool, as the selector description needs it. */
export interface ActionSelectorEntry {
  name: string;
  /** Short per-action hint, if the spec gives one. */
  hint?: string;
  /** The action's required arguments, other than `action` itself. */
  required: string[];
}

/**
 * Whether `name` already appears as a whole word in `text`, so a required
 * argument a hint already names is not repeated. Word boundaries keep
 * `message_id` from matching inside `message_ids`.
 */
function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * The description of a consolidated tool's `action` property.
 *
 * Shape: `Operation to run. <a> = <hint>; <b> = <hint>. Required: <a>: x, y;
 * <c>: z.` The `Required:` clause lists, per action, only the required
 * arguments its own hint does not already name; an action whose hint names
 * them all, or which requires nothing, does not appear in it. This is the only
 * place `tools/list` states per-action required arguments now that the
 * `allOf` rules are not advertised, so it must lose none of them.
 */
export function actionSelectorDescription(actions: ActionSelectorEntry[]): string {
  const hints = actions
    .filter((action) => action.hint)
    .map((action) => `${action.name} = ${action.hint}`)
    .join("; ");
  const required = actions
    .map((action) => ({
      name: action.name,
      missing: action.required.filter((argument) => !mentions(action.hint ?? "", argument)),
    }))
    .filter((action) => action.missing.length > 0)
    .map((action) => `${action.name}: ${action.missing.join(", ")}`)
    .join("; ");
  let description = hints ? `Operation to run. ${hints}.` : "Operation to run.";
  if (required) description += ` Required: ${required}.`;
  return description;
}
