// The checkout.feedback notification: what the owner reads when someone answers
// the "what stopped you?" card after abandoning a Stripe checkout.
//
// Pure on purpose. index.ts gathers the context with the service-role client
// and hands it here; this file imports nothing, so the wording is covered by a
// plain node test (apps/web/src/lib/analytics/checkout-feedback-email.test.ts)
// without a Deno runtime or a database.
//
// Every field may be null: each lookup in index.ts is guarded on its own, and a
// feedback email with one "unknown" in it is worth more than no email.

export type CheckoutFeedbackContext = {
  feedbackId: string;
  reason: string | null;
  detail: string | null;
  target: string | null;
  answeredAt: string | null;
  ownerEmail: string | null;
  workspaceId: string;
  workspaceName: string | null;
  plan: string | null;
  signedUpAt: string | null;
  emailSegment: string | null;
  acquisitionSource: string | null;
  marketingOptIn: boolean | null;
  inboxCount: number | null;
  inboxProviders: string[];
  clients: string[];
  actionsTotal: number | null;
  lastActionAt: string | null;
  inboxGateHits: number | null;
  checkoutStarts: number | null;
  lastCheckoutStartedAt: string | null;
  earlierAnswers: number | null;
};

// The answer as the owner should read it, not as the card worded it to the
// user. Keys must match CHECKOUT_FEEDBACK_REASONS in
// apps/web/src/lib/analytics/checkout-feedback.ts; an unknown key is printed
// as-is rather than dropped, so a new option still produces a readable email
// before this map learns about it.
export const CHECKOUT_FEEDBACK_REASON_LABELS: Record<string, string> = {
  price_too_high: "Costs more than they expected",
  compare_plans: "Wants to compare the plans first",
  want_to_try_first: "Wants to try it more before paying",
  payment_method: "Could not pay the way they wanted",
  just_checking_price: "Was just checking the price",
  other: "Other",
};

const PLAN_NAMES: Record<string, string> = { personal: "Personal", solo: "Solo", pro: "Pro", free: "Free" };

/** "personal_month" -> "Personal, monthly". Unknown shapes are printed as-is. */
export function describeCheckoutTarget(target: string | null): string {
  if (!target) return "unknown";
  const match = /^([a-z]+)_(month|year)$/.exec(target);
  if (!match) return target;
  const plan = PLAN_NAMES[match[1]] ?? match[1];
  return `${plan}, ${match[2] === "month" ? "monthly" : "annual"}`;
}

/** Whole-unit gap between two ISO timestamps, e.g. "22 seconds", "3 days". */
export function describeGap(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return unit(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
}

const show = (value: string | number | null): string => (value === null || value === "" ? "unknown" : String(value));
const list = (values: string[]): string => (values.length > 0 ? values.join(", ") : "none");

export function renderCheckoutFeedbackEmail(ctx: CheckoutFeedbackContext): { subject: string; body: string } {
  const reasonLabel = ctx.reason ? (CHECKOUT_FEEDBACK_REASON_LABELS[ctx.reason] ?? ctx.reason) : "unknown";
  const who = ctx.ownerEmail ?? ctx.workspaceName ?? ctx.workspaceId;
  const target = describeCheckoutTarget(ctx.target);
  // What they typed is the most valuable thing in the mail, so when there is
  // any it leads; the fixed label alone says less than their own sentence.
  const said = ctx.detail ? `"${ctx.detail}"` : reasonLabel;

  // These mails thread into one conversation, so every one after the first
  // arrives as a reply with the first mail's subject. The first body line has
  // to carry the whole answer by itself: it is all a phone preview shows.
  const headline = `${said} | ${who} | wanted ${target}`;

  const onStripe = describeGap(ctx.lastCheckoutStartedAt, ctx.answeredAt);
  const tenure = describeGap(ctx.signedUpAt, ctx.answeredAt);
  const optIn = ctx.marketingOptIn === null ? "unknown" : ctx.marketingOptIn ? "yes" : "no";

  const body = [
    headline,
    "",
    "WHAT THEY SAID",
    `answer: ${reasonLabel}`,
    ...(ctx.detail ? [`in their words: "${ctx.detail}"`] : []),
    `answered: ${show(ctx.answeredAt)}`,
    "",
    "WHAT THEY WERE BUYING",
    `plan: ${target}`,
    `opened Stripe: ${show(ctx.lastCheckoutStartedAt)}`,
    // Opening Stripe to answering the card. An upper bound on time spent on
    // the payment page: it also includes reading the card.
    `back and answering after: ${onStripe ?? "unknown"}`,
    `checkouts opened, ever: ${show(ctx.checkoutStarts)}`,
    `inbox-limit gate shown: ${ctx.inboxGateHits === null ? "unknown" : `${ctx.inboxGateHits} time${ctx.inboxGateHits === 1 ? "" : "s"}`}`,
    `earlier answers from this workspace: ${show(ctx.earlierAnswers)}`,
    "",
    "WHO",
    `email: ${show(ctx.ownerEmail)}`,
    `workspace: ${show(ctx.workspaceName)} (${ctx.workspaceId})`,
    `plan now: ${show(ctx.plan)}`,
    `signed up: ${show(ctx.signedUpAt)}${tenure ? ` (${tenure} before answering)` : ""}`,
    `email type: ${show(ctx.emailSegment)}`,
    `came from: ${show(ctx.acquisitionSource)}`,
    `marketing opt-in: ${optIn}`,
    "",
    "HOW THEY USE IT",
    `inboxes connected: ${show(ctx.inboxCount)}${ctx.inboxProviders.length > 0 ? ` (${ctx.inboxProviders.join(", ")})` : ""}`,
    `clients: ${list(ctx.clients)}`,
    `tool calls, ever: ${show(ctx.actionsTotal)}`,
    `last tool call: ${ctx.lastActionAt ?? "never"}`,
    "",
    `feedback_id: ${ctx.feedbackId}`,
  ].join("\n");

  return { subject: `Checkout feedback: ${reasonLabel} (${who})`, body };
}
