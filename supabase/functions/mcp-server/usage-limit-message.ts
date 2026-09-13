// ---------------------------------------------------------------------------
// The words a workspace sees when an action is refused for want of allowance.
//
// Read this first: there are TWO different limits behind one function, and
// the text must say which one the reader hit.
//
//   Free    150 billable email actions per UTC calendar month, the first 7
//           days after signup uncounted (docs/PLAN-free-action-cap-150.md,
//           decision 2026-09-12). This IS a plan limit, it is printed on the
//           pricing page, and the Personal plan removes it. Saying so is a
//           true statement about the product, and the one thing the person
//           behind the agent needs to know.
//
//   Paid    a silent abuse ceiling set far above anything a real account does
//           (25k / 100k / 500k per period). Nothing sells or upsells against
//           it, because no plan raises it; the remedy is a human. That text is
//           unchanged from the 2026-08-19 repricing, and the assertions that
//           keep it from growing back into a paywall still stand for these
//           plans.
//
// Workspaces from before the Free allowance launched are exempt and never
// reach this file; neither does anything in its first week.
//
// The transport reasoning below predates both and still holds. Until it was
// fixed, this text was four words long: the server returned a JSON-RPC
// protocol error, `-32029 Usage limit reached`, with the cap, the reset date
// and the link tucked into `error.data`. The reference MCP SDK renders a
// protocol error as the string `MCP error ${code}: ${message}` and hangs
// `data` off a separate property that hosts routinely drop, so the model was
// handed four words and improvised the rest. The user got an apology and a
// guess.
//
// The MCP specification draws the line this file sits on. Tool EXECUTION errors
// (business logic: quota exhausted, upstream refused) are returned as a normal
// result with `isError: true`, because clients SHOULD hand those to the model,
// which can then act on them. Protocol errors are for malformed or
// unroutable requests, and clients only MAY forward those. Running out of
// allowance is the textbook execution error, so the text below travels in
// `content[0].text` where the model reads it like any other tool output.
//
// Kept in its own module for the same reason as text-safety.ts: it is a pure
// function of its arguments and is worth testing without booting the server.
// ---------------------------------------------------------------------------

/**
 * Customer-facing plan names.
 *
 * The internal plan ids have never matched the pricing page and drifted twice:
 * `solo` was sold as Solo, then Agent, and is now Pro; `pro` was Team, then
 * Scale, and is Team again. `personal` is the lone id that matches the name it
 * is sold under, which makes it the easy one to mis-read the others against. A
 * message a person reads has to use the name printed on the pricing page.
 * Mirror of `planDisplayName` in apps/web/src/lib/stripe/plans.ts.
 */
export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: "Free",
  personal: "Personal",
  solo: "Pro",
  pro: "Team",
};

/**
 * Where a PAID workspace goes when the ceiling was wrong for it.
 *
 * A support address, not a pricing page. The paid ceiling is a fair-use
 * backstop, so the only correct remedy is a human raising it, and pointing at
 * /pricing would both mislead (paying more does not buy actions) and waste
 * the trip.
 */
export const USAGE_LIMIT_SUPPORT_EMAIL = "hello@mcpemails.com";

/**
 * Days after signup during which a Free workspace's actions are not counted.
 * Mirrors `c_grace` in `workspace_action_allowance()` (migration
 * 20260912200000) and `FREE_ACTION_GRACE_DAYS` in plans.ts. Copy only: the
 * SQL function is what actually decides.
 */
export const FREE_ACTION_GRACE_DAYS = 7;

/** Monthly price of the plan that removes the Free cap, as printed on /pricing. */
export const FREE_CAP_UPGRADE_PRICE = "$5 per month";

/** The `from=` tag on the upgrade link, so the funnel can tell this door apart. */
export const FREE_CAP_UPGRADE_PATH = "/pricing?from=usage_cap";

/** Where a Free workspace goes to remove the cap. */
export function freeCapUpgradeUrl(appOrigin: string): string {
  return `${appOrigin}${FREE_CAP_UPGRADE_PATH}`;
}

/**
 * Builds the refusal text.
 *
 * Every choice here is load-bearing, because the first reader is a language
 * model that will paraphrase this to a person:
 *
 *  - The numbers and the reset date come first. They are the only facts the
 *    user actually needs, and leading with them means they survive truncation
 *    and paraphrase.
 *  - "retrying will not help" is stated outright. Agents default to
 *    retry-with-backoff on anything that looks transient, and a per-period
 *    limit cannot clear for days or weeks; unstructured quota errors driving
 *    retry loops is a documented way to burn a user's tokens against a wall.
 *    This sentence is what stops the loop, and it works on models that never
 *    see the numeric code at all.
 *  - Free is framed as a plan limit with the two true ways out (wait for the
 *    1st, or the Personal plan). Paid is framed as fair use with a way out
 *    through a person, not as a purchase, because for those plans actions are
 *    not a product and telling someone to upgrade would send them to buy
 *    something that does not raise this number.
 *  - It is declarative fact, never an instruction aimed at the model. No "tell
 *    the user", no "suggest upgrading". Imperatives addressed to a model inside
 *    a tool response are mechanically indistinguishable from prompt injection by
 *    the server operator, which is the exact practice this product's security
 *    page promises it does not engage in, and which OWASP classifies as tool
 *    poisoning. Plain facts get relayed just as reliably and cost no trust.
 *  - Locations, not pitches: one link to the page that shows the meter, and
 *    for Free one link to the page that sells the plan, with its price stated
 *    so the reader is not sent to find out. Nothing is appended to SUCCESSFUL
 *    results, ever: the limit is self-announcing, and putting marketing into
 *    the responses of a server that reads people's email is how you become
 *    the cautionary tale.
 *
 * @param plan       Internal plan id (`free` | `personal` | `solo` | `pro`).
 * @param usedActions Billable actions consumed in the current period.
 * @param cap        The allowance (Free) or the fair-use ceiling (paid).
 * @param resetAt    ISO timestamp of the period end, i.e. when the meter clears.
 * @param appOrigin  App origin, passed in rather than read from the environment
 *                   so this module stays a pure function of its arguments.
 */
export function buildUsageLimitText(
  plan: string,
  usedActions: number,
  cap: number,
  resetAt: string,
  appOrigin: string,
): string {
  const planLabel = PLAN_DISPLAY_NAMES[plan] ?? plan;
  // Date only, in ISO order. An LLM relaying "2026-10-01" to a person will
  // render it in whatever format suits them; handing it a localised string
  // instead invites it to reformat an already-ambiguous date into a wrong one.
  const resetDate = resetAt.slice(0, 10);
  const used = usedActions.toLocaleString("en-US");
  const total = cap.toLocaleString("en-US");

  if (plan === "free") {
    return `Monthly allowance reached: ${used} of ${total} email actions used this month on the ${planLabel} plan. ` +
      `The counter resets on ${resetDate}. Until then every email action in this workspace will be refused, ` +
      `so retrying will not help: this is a plan limit, not a temporary failure. ` +
      `The ${planLabel} plan includes ${total} email actions per calendar month; the first ${FREE_ACTION_GRACE_DAYS} days ` +
      `after signup are not counted. inbox_list and the dashboard keep working. ` +
      `The Personal plan removes the monthly cap for ${FREE_CAP_UPGRADE_PRICE} at ${freeCapUpgradeUrl(appOrigin)}. ` +
      `The current count is at ${appOrigin}/dashboard/usage.`;
  }

  return `Fair-use limit reached: ${used} of ${total} email actions used this period on the ${planLabel} plan. ` +
    `The counter resets on ${resetDate}. Until then every email action in this workspace will be refused, ` +
    `so retrying will not help: this is a fixed limit, not a temporary failure. ` +
    `This limit is an automated safeguard against runaway usage, not a billing tier, and it is set far above ` +
    `normal use. If this workspace has a legitimate reason to run above it, the owner can contact ` +
    `${USAGE_LIMIT_SUPPORT_EMAIL} to have it raised. The current count is at ${appOrigin}/dashboard/usage.`;
}
