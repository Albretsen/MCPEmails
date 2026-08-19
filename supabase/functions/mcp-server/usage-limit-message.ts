// ---------------------------------------------------------------------------
// The words a workspace sees when it trips the fair-use action ceiling.
//
// Read this first: the ceiling is NOT a paywall any more. The 2026-08-19
// repricing moved the value metric to connected inboxes, and actions became a
// silent abuse ceiling set far above anything a real account does. Nothing in
// this file may sell, upsell, or imply that paying buys more actions, because
// it does not. A message that says "upgrade for a bigger allowance" would be a
// false statement about the product. What a person who hits this needs is to
// know it happened, that retrying is pointless, and how to reach a human.
//
// The transport reasoning below predates the repricing and still holds. Until
// it was fixed, this text was four words long: the server returned a JSON-RPC
// protocol error, `-32029 Usage limit reached`, with the cap, the reset date
// and the link tucked into
// `error.data`. The reference MCP SDK renders a protocol error as the string
// `MCP error ${code}: ${message}` and hangs `data` off a separate property that
// hosts routinely drop, so the model was handed four words and improvised the
// rest. The user got an apology and a guess.
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
 * Scale, and is Team again. A message a person reads has to use the name
 * printed on the pricing page. Mirror of `planDisplayName` in
 * apps/web/src/lib/stripe/plans.ts.
 */
export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: "Free",
  solo: "Pro",
  pro: "Team",
};

/**
 * Where a person goes when the ceiling was wrong for them.
 *
 * A support address, not a pricing page. The ceiling is a fair-use backstop, so
 * the only correct remedy is a human raising it, and pointing at /pricing would
 * both mislead (paying does not buy actions) and waste the trip.
 */
export const USAGE_LIMIT_SUPPORT_EMAIL = "hello@mcpemails.com";

/**
 * Builds the ceiling-rejection text.
 *
 * Every choice here is load-bearing, because the first reader is a language
 * model that will paraphrase this to a person:
 *
 *  - The numbers and the reset date come first. They are the only facts the
 *    user actually needs, and leading with them means they survive truncation
 *    and paraphrase.
 *  - "retrying will not help" is stated outright. Agents default to
 *    retry-with-backoff on anything that looks transient, and a per-period
 *    ceiling cannot clear for days or weeks; unstructured quota errors driving
 *    retry loops is a documented way to burn a user's tokens against a wall.
 *    This sentence is what stops the loop, and it works on models that never
 *    see the numeric code at all.
 *  - It is framed as fair use with a way out through a person, not as a
 *    purchase. Actions are not a product. Telling someone to upgrade would send
 *    them to buy something that does not raise this number.
 *  - It is declarative fact, never an instruction aimed at the model. No "tell
 *    the user", no "suggest upgrading". Imperatives addressed to a model inside
 *    a tool response are mechanically indistinguishable from prompt injection by
 *    the server operator, which is the exact practice this product's security
 *    page promises it does not engage in, and which OWASP classifies as tool
 *    poisoning. Plain facts get relayed just as reliably and cost no trust.
 *  - One contact address and one link to the page that shows the meter. A
 *    location, not a pitch. Nothing is appended to SUCCESSFUL results, ever:
 *    the ceiling is self-announcing, and putting marketing into the responses of
 *    a server that reads people's email is how you become the cautionary tale.
 *
 * @param plan       Internal plan id (`free` | `solo` | `pro`).
 * @param usedActions Billable actions consumed in the current billing period.
 * @param cap        The plan's fair-use ceiling for that period.
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
  // Date only, in ISO order. An LLM relaying "2026-09-01" to a person will
  // render it in whatever format suits them; handing it a localised string
  // instead invites it to reformat an already-ambiguous date into a wrong one.
  const resetDate = resetAt.slice(0, 10);
  const used = usedActions.toLocaleString("en-US");
  const total = cap.toLocaleString("en-US");
  return `Fair-use limit reached: ${used} of ${total} email actions used this period on the ${planLabel} plan. ` +
    `The counter resets on ${resetDate}. Until then every email action in this workspace will be refused, ` +
    `so retrying will not help: this is a fixed limit, not a temporary failure. ` +
    `This limit is an automated safeguard against runaway usage, not a billing tier, and it is set far above ` +
    `normal use. If this workspace has a legitimate reason to run above it, the owner can contact ` +
    `${USAGE_LIMIT_SUPPORT_EMAIL} to have it raised. The current count is at ${appOrigin}/dashboard/usage.`;
}
