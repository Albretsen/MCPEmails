// ---------------------------------------------------------------------------
// Arguments that belong to a sibling action of a consolidated tool.
//
// A consolidated tool (email_read, email_organize, …) publishes ONE flat
// `properties` map holding the union of every action's arguments, and relies on
// an `allOf` of if/then/not rules to say which subset each action actually
// accepts. Models read the flat map far more reliably than the conditional
// rules, so they routinely send `email_read {action: "list", subject: "..."}`
// or `{action: "search", unread_only: false}`. Every one of those was refused
// outright: 463 refusals across 40 external workspaces in the 30 days to
// 2026-08-25, the single largest error class on the product, one user at a 38%
// error rate.
//
// Refusing all of them is wrong, and accepting all of them is worse. The two
// cases hiding inside that number are genuinely different:
//
//   IGNORABLE   The argument cannot have changed the outcome. `include_html:
//               false` on a list, `offset: 0`, `include_folders: []`. The
//               published schema declares those exact values as the property's
//               default, so by its own contract sending them is the same as
//               omitting them. Dropping one loses no instruction, and the call
//               that a model meant to make succeeds on the first attempt.
//
//   MISPLACED   The argument asserts something. `subject: "invoice"` on a list,
//               `unread_only: true` on a search, `flagged: false` (which the
//               search translator turns into UNFLAGGED, not "no filter").
//               Running the call without it returns mail the caller did not
//               ask for, and neither the model nor the user has any way to
//               notice: the result looks like a perfectly good answer to a
//               question nobody asked. These stay refused, and the refusal now
//               names the action each argument does belong to, which is the
//               one fact that turns a dead end into a corrected retry.
//
// The line between them is drawn mechanically, never by taste: see
// isAbsenceEquivalent. A property whose default expresses a positive selection
// (email_list's `folder`, default "INBOX") never qualifies, because a caller
// who sends `folder: "INBOX"` to `search` means to restrict the search to the
// inbox, and silently widening a search back to every folder is exactly the
// invisible semantic change this module exists to prevent.
//
// Pure and dependency-free so the classification can be tested without booting
// the server, for the same reason as invalid-arguments-message.ts.
// ---------------------------------------------------------------------------

/**
 * What each action of one consolidated tool accepts, derived from the same
 * merge that builds the published input schema so the two cannot drift.
 */
export interface ActionArgumentIndex {
  /** Exposed property name → the actions that accept it, in registry order. */
  ownersByProperty: Record<string, string[]>;
  /** Action name → every exposed property it accepts, `action` included. */
  allowedByAction: Record<string, string[]>;
  /**
   * Exposed property name → the default the PUBLISHED schema declares for it,
   * recorded only where that default is absence-equivalent. A property absent
   * from this map can never be ignored, whatever value it carries.
   */
  neutralDefaults: Record<string, unknown>;
}

/** An argument that asserts something the selected action cannot honour. */
export interface MisplacedArgument {
  property: string;
  /** The actions of the same tool that do accept it. Never empty. */
  owners: string[];
}

export interface ExtraArgumentReview {
  /** Sibling arguments that provably cannot change the outcome. */
  ignorable: string[];
  /** Sibling arguments that could have changed the outcome. */
  misplaced: MisplacedArgument[];
}

/** The error shape the server's schema validator produces. */
export interface SchemaErrorLike {
  path: string;
  keyword: string;
  message: string;
}

/**
 * Values that mean "no constraint, no extra work" in any reading: false, zero,
 * the empty string, the empty array. A default drawn from this set is the
 * schema stating that the property, unset, imposes nothing, so a caller sending
 * it imposes nothing either, whichever action ends up running.
 *
 * `true` is deliberately absent even though several properties default to it
 * (include_signature). `true` can encode a positive request just as "INBOX"
 * does, and the cost of being wrong here is a silent behaviour change, while
 * the cost of being over-strict is one extra round trip carrying a message that
 * says precisely what to send instead.
 */
function isAbsenceEquivalent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value === false || value === 0 || value === "";
}

/** Whether `value` is the neutral default itself, and so carries no intent. */
function assertsNothing(value: unknown, neutralDefault: unknown): boolean {
  if (Array.isArray(neutralDefault)) return Array.isArray(value) && value.length === 0;
  return value === neutralDefault;
}

/**
 * Records a property's default in an index only when it is absence-equivalent.
 * Exported for the schema builder, which is the only caller: keeping the test
 * in one place is what stops the two sides of the contract from drifting.
 */
export function neutralDefaultOf(propertySchema: unknown): { present: boolean; value: unknown } {
  if (propertySchema === null || typeof propertySchema !== "object" || Array.isArray(propertySchema)) {
    return { present: false, value: undefined };
  }
  const record = propertySchema as Record<string, unknown>;
  if (!("default" in record) || !isAbsenceEquivalent(record.default)) {
    return { present: false, value: undefined };
  }
  return { present: true, value: record.default };
}

/**
 * Split the arguments the selected action does not accept into the ones that
 * may be dropped and the ones that must be reported.
 *
 * Arguments the tool does not declare at all (a typo, a field from another
 * tool entirely) are NOT returned here. They belong to the schema's
 * `additionalProperties: false` rule, which already names them one by one, and
 * guessing at an unknown name is how a typo becomes a silently ignored filter.
 */
export function reviewExtraArguments(
  index: ActionArgumentIndex,
  action: string,
  args: Record<string, unknown>,
): ExtraArgumentReview {
  const allowed = new Set(index.allowedByAction[action] ?? []);
  const ignorable: string[] = [];
  const misplaced: MisplacedArgument[] = [];
  for (const property of Object.keys(args)) {
    if (allowed.has(property)) continue;
    const owners = index.ownersByProperty[property];
    if (!owners || owners.length === 0) continue; // not ours to judge
    if (
      property in index.neutralDefaults &&
      assertsNothing(args[property], index.neutralDefaults[property])
    ) {
      ignorable.push(property);
      continue;
    }
    misplaced.push({ property, owners: owners.filter((owner) => owner !== action) });
  }
  return { ignorable, misplaced };
}

/** "action 'search'" / "actions 'search' or 'read'", for the message below. */
function ownerPhrase(owners: string[]): string {
  const quoted = owners.map((owner) => `'${owner}'`);
  if (quoted.length === 1) return `action ${quoted[0]}`;
  const last = quoted.pop() as string;
  return `actions ${quoted.join(", ")} or ${last}`;
}

/**
 * Rewrite the validator's generic "not an argument of the selected action"
 * failures so each one names the action that does take the argument.
 *
 * The validator cannot do this itself: it walks a plain JSON Schema and the
 * ownership map is not in there. Putting it in there was considered and
 * rejected. Every consolidated tool would have to carry an annotation per
 * forbidden property per action (email_read alone has roughly seventy-five of
 * those pairs), and tools/list is sent on every connect, so the whole tool
 * surface would grow by a few thousand tokens to serve a message only a
 * failing call ever reads.
 *
 * Errors this review says nothing about are returned untouched, so a `not`
 * rule from anywhere else keeps its own wording.
 */
export function withOwningActions<T extends SchemaErrorLike>(
  errors: readonly T[],
  review: ExtraArgumentReview,
  action: string,
  rootPath = "arguments",
): T[] {
  if (review.misplaced.length === 0) return [...errors];
  const byPath = new Map<string, MisplacedArgument>();
  for (const entry of review.misplaced) byPath.set(`${rootPath}.${entry.property}`, entry);
  return errors.map((error) => {
    if (error.keyword !== "not") return error;
    const entry = byPath.get(error.path);
    if (!entry || entry.owners.length === 0) return error;
    return {
      ...error,
      message:
        `is not an argument of action '${action}'; it belongs to ` +
        ownerPhrase(entry.owners),
    };
  });
}
