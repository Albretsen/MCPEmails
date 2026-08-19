// ---------------------------------------------------------------------------
// The words a workspace sees when it runs out of actions.
//
// This is the only paywall this product has, and until now it was four words
// long. The server returned a JSON-RPC protocol error, `-32029 Usage limit
// reached`, with the cap, the reset date and the upgrade link tucked into
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
 * The internal plan ids predate the pricing page and no longer match it: `solo`
 * is sold as Agent and `pro` as Scale. A message the user reads has to use the
 * name printed on the pricing page, or the upgrade path names a product they
 * cannot find.
 */
export const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: "Free",
  solo: "Agent",
  pro: "Scale",
};

/**
 * Builds the cap-rejection text.
 *
 * Every choice here is load-bearing, because the first reader is a language
 * model that will paraphrase this to a person:
 *
 *  - The numbers and the reset date come first. They are the only facts the
 *    user actually needs, and leading with them means they survive truncation
 *    and paraphrase.
 *  - "retrying will not help" is stated outright. Agents default to
 *    retry-with-backoff on anything that looks transient, and a monthly cap
 *    cannot clear for days or weeks; unstructured quota errors driving retry
 *    loops is a documented way to burn a user's tokens against a wall. This
 *    sentence is what stops the loop, and it works on models that never see the
 *    numeric code at all.
 *  - It is declarative fact, never an instruction aimed at the model. No "tell
 *    the user", no "suggest upgrading". Imperatives addressed to a model inside
 *    a tool response are mechanically indistinguishable from prompt injection by
 *    the server operator, which is the exact practice this product's security
 *    page promises it does not engage in, and which OWASP classifies as tool
 *    poisoning. Plain facts get relayed just as reliably and cost no trust.
 *  - One link, to the page that shows the meter and carries the upgrade CTA. A
 *    location, not a pitch. Nothing is appended to SUCCESSFUL results, ever:
 *    the cap is self-announcing, and putting marketing into the responses of a
 *    server that reads people's email is how you become the cautionary tale.
 *
 * @param plan       Internal plan id (`free` | `solo` | `pro`).
 * @param usedActions Billable actions consumed in the current billing period.
 * @param cap        The plan's allowance for that period.
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
  return `Usage limit reached: ${used} of ${total} monthly actions used on the ${planLabel} plan. ` +
    `The allowance resets on ${resetDate}. Until then every email action in this workspace will be refused, ` +
    `so retrying will not help: this is a plan limit, not a temporary failure. ` +
    `The workspace owner can see the meter and change plan at ${appOrigin}/dashboard/usage.`;
}
