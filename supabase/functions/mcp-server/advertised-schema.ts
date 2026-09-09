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
//
// ── The same seam, now at the level of tools and actions ────────────────────
//
// 2026-09-09: the split between "what we advertise" and "what we accept" grew
// a second job. Anthropic's connector review criteria reject a tool that mixes
// safe and unsafe operations in one entry point:
//
//   "A single tool that accepts both safe HTTP methods (GET, HEAD, OPTIONS)
//   and unsafe methods (POST, PUT, PATCH, DELETE) is rejected. [...] Split
//   into a read-only tool and one or more write tools. Documenting safe versus
//   unsafe operations within one tool's description does not satisfy this
//   requirement, the operations must be in separate tools."
//
// A read-only tool MAY keep an `action` enum, which is why `email_read` is
// already compliant. Five tools were not: `folder`, `draft`, `schedule`,
// `signature` and `automation` each mixed a read action in with their writes.
//
// The hard constraint is that we cannot simply move those actions. claude.ai
// caches a connector's tool SET at connect time, so every user connected today
// holds `folder`, `draft`, `schedule`, `signature` and `automation` with their
// CURRENT action enums. If those names stopped accepting their read actions,
// every existing connection would break at the first `folder{action:"list"}`.
//
// So the split is advertised-only, in exactly the same shape as the `allOf`
// strip above:
//
//   • `UNADVERTISED_TOOLS` names tools kept in the registry, and therefore
//     fully callable and fully validated, that `tools/list` no longer emits.
//     `signature` is the only one: its two actions now ship as the standalone
//     `signature_get` and `signature_set`, so nothing is left for the mixed
//     name to advertise.
//
//   • An action carrying `advertised: false` in CONSOLIDATED_SPECS stays in
//     the tool's validated schema, its selector index, its argument index and
//     its dispatch, and is simply left out of the enum `tools/list` publishes.
//     That is how `folder` advertises create|rename|delete while still running
//     `folder{action:"list"}` for a client that connected last month.
//
// The read halves are advertised under new names instead: `folder_list`,
// `draft_list`, `schedule_list`, `signature_get` and `signature_set` are the
// pre-consolidation legacy entries promoted back onto the surface, and
// `automation_read` is a new read-only consolidated tool over
// list|get|runs|preview. Every one of them dispatches to the very same handler
// the corresponding action always did, so the two surfaces cannot diverge in
// behaviour: they are two names for one code path.
// ---------------------------------------------------------------------------

/**
 * Tools that stay in the registry, and therefore stay callable and validated,
 * but that `tools/list` does not emit.
 *
 * `signature` mixed a read (`get`) and a write (`set`) under one name. Both
 * halves are now advertised separately as `signature_get` and `signature_set`,
 * which leaves this name with nothing compliant to advertise — but every
 * client that connected before today has it cached, so it must keep working.
 *
 * This is deliberately a name list rather than a flag on the registry entry:
 * an unadvertised tool is a back-compatibility obligation, not a property of
 * the tool, and the obligation is easier to audit when it is written down in
 * one place next to the reason for it.
 */
export const UNADVERTISED_TOOLS: ReadonlySet<string> = new Set(["signature"]);

/** Whether `tools/list` emits this tool. Everything not withheld is listed. */
export function isAdvertisedTool(name: string): boolean {
  return !UNADVERTISED_TOOLS.has(name);
}

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
