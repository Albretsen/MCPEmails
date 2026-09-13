// ---------------------------------------------------------------------------
// The refusal message is what a person sees when their agent is stopped
// mid-task, and it had no test at all before this file existed.
//
// These assertions are about behaviour, not wording: the numbers must be
// present, the reset date must be unambiguous, the "do not retry" signal must
// survive, the text must not address the model in the imperative, and the two
// limits behind the one function must not be confused: Free is a plan limit
// with a true upgrade path, paid is a fair-use ceiling that no purchase
// raises. Rewording the sentences is fine. Losing any of those properties is
// not.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  buildUsageLimitText,
  FREE_ACTION_GRACE_DAYS,
  FREE_CAP_UPGRADE_PATH,
  freeCapUpgradeUrl,
  PLAN_DISPLAY_NAMES,
  USAGE_LIMIT_SUPPORT_EMAIL,
} from "./usage-limit-message.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}: expected to find ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}

const ORIGIN = "https://mcpemails.com";

// The Free allowance, mirrored from c_free_cap in workspace_action_allowance()
// (migration 20260912200000). The paid ceilings are the silent ones from the
// same function.
const FREE_ALLOWANCE = 150;
const PRO_CEILING = 100_000;

const RESET = "2026-10-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Properties shared by both limits
// ---------------------------------------------------------------------------

Deno.test("both messages lead with the numbers the user needs", () => {
  const free = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(free, "150 of 150", "used and cap for Free");
  // Leading with them is the point: they have to survive a truncating client
  // and a paraphrasing model.
  assert(free.indexOf("150 of 150") < 60, "Free numbers must appear in the first clause");

  const paid = buildUsageLimitText("solo", PRO_CEILING, PRO_CEILING, RESET, ORIGIN);
  assertIncludes(paid, "100,000 of 100,000", "used and cap for paid, thousand-separated");
  assert(paid.indexOf("100,000 of 100,000") < 60, "paid numbers must appear in the first clause");
});

Deno.test("both messages state the reset date in unambiguous ISO order", () => {
  for (const plan of ["free", "solo"]) {
    const text = buildUsageLimitText(plan, 1, 2, RESET, ORIGIN);
    assertIncludes(text, "2026-10-01", `${plan}: reset date`);
    assert(!text.includes("T00:00:00"), `${plan}: the time component is noise for a human reader`);
  }
});

Deno.test("both messages tell the agent not to retry", () => {
  // An agent's default reflex on an unclassified failure is retry-with-backoff.
  // A per-period limit cannot clear for days, so this phrase is what stops the
  // loop on clients that never surface a numeric error code at all.
  for (const plan of ["free", "personal", "solo", "pro"]) {
    const lower = buildUsageLimitText(plan, 10, 10, RESET, ORIGIN).toLowerCase();
    assertIncludes(lower, "retrying will not help", `${plan}: explicit non-retryable signal`);
    assertIncludes(lower, "not a temporary failure", `${plan}: rules out transient-failure reading`);
  }
});

Deno.test("both messages point at the meter on the configured origin", () => {
  for (const plan of ["free", "solo"]) {
    const text = buildUsageLimitText(plan, 5, 5, RESET, "https://staging.example.com");
    assertIncludes(text, "https://staging.example.com/dashboard/usage", `${plan}: link honours the passed origin`);
    assert(!text.includes("mcpemails.com/dashboard"), `${plan}: no hard-coded production origin`);
  }
});

Deno.test("neither message ever instructs the model", () => {
  // Imperatives aimed at the model inside a tool response are what tool
  // poisoning looks like from the outside. This server reads people's email;
  // it does not get to issue instructions into their agent's context. This
  // holds for the Free text too: it states that Personal removes the cap, it
  // never asks anyone to suggest it.
  for (const plan of ["free", "personal", "solo", "pro"]) {
    const text = buildUsageLimitText(plan, 10, 10, RESET, ORIGIN).toLowerCase();
    for (
      const phrase of [
        "tell the user", "you should", "please upgrade", "inform the user", "ask them to",
        "suggest", "recommend", "encourage", "remind the user",
      ]
    ) {
      assert(!text.includes(phrase), `${plan}: message must not address the model: found ${JSON.stringify(phrase)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Free: a plan limit, with the facts a person needs to decide what to do
// ---------------------------------------------------------------------------

Deno.test("Free names it a plan limit on the Free plan, never fair use", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(text, "Monthly allowance reached", "opens as an allowance, not a safeguard");
  assertIncludes(text, "Free plan", "names the plan");
  assertIncludes(text.toLowerCase(), "plan limit", "framed as a plan limit");
  const lower = text.toLowerCase();
  for (const phrase of ["fair-use", "fair use", "safeguard", "runaway", USAGE_LIMIT_SUPPORT_EMAIL]) {
    assert(!lower.includes(phrase.toLowerCase()), `Free must not borrow the paid framing: found ${JSON.stringify(phrase)}`);
  }
});

Deno.test("Free states the number exactly as passed, with no thousands noise", () => {
  // The number a customer reads on /pricing is the number that blocks them.
  // The text must print the cap it was handed, not a constant of its own.
  assertIncludes(buildUsageLimitText("free", 150, 150, RESET, ORIGIN), "150 of 150 email actions", "150 as passed");
  assertIncludes(buildUsageLimitText("free", 150, 150, RESET, ORIGIN), "includes 150 email actions per calendar month", "the allowance sentence uses the passed cap");
  // If the function ever changes the cap, the text follows without an edit here.
  assertIncludes(buildUsageLimitText("free", 200, 200, RESET, ORIGIN), "200 of 200 email actions", "a different cap prints as itself");
  assert(!buildUsageLimitText("free", 200, 200, RESET, ORIGIN).includes("150"), "no stale constant leaks into the text");
});

Deno.test("Free says the first seven days were not counted", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(text, `first ${FREE_ACTION_GRACE_DAYS} days after signup are not counted`, "the grace sentence");
  assert(FREE_ACTION_GRACE_DAYS === 7, "the grace constant mirrors c_grace in workspace_action_allowance()");
});

Deno.test("Free says what keeps working", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(text, "inbox_list and the dashboard keep working", "the non-billable tool and the dashboard are named");
});

Deno.test("Free carries the upgrade URL with its funnel tag and the price", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(text, `${ORIGIN}${FREE_CAP_UPGRADE_PATH}`, "upgrade link on the passed origin");
  assertIncludes(text, "$5 per month", "the price is stated, not left to be discovered");
  assertIncludes(text, "Personal plan removes the monthly cap", "the true remedy is named as a fact");
  assert(FREE_CAP_UPGRADE_PATH.includes("from=usage_cap"), "the funnel tag tells this door apart");
  assert(freeCapUpgradeUrl("https://x.test") === "https://x.test/pricing?from=usage_cap", "helper builds the same URL");
});

// ---------------------------------------------------------------------------
// Paid: fair use, a human to talk to, nothing for sale
// ---------------------------------------------------------------------------

Deno.test("paid plans read as fair use with a human to talk to, not an upsell", () => {
  // On paid plans actions are not sold. Telling a customer to upgrade would be
  // a false statement about the product: no plan raises this number, only a
  // person can. This is the assertion that keeps the paid ceiling from growing
  // into a paywall.
  for (const plan of ["personal", "solo", "pro"]) {
    const text = buildUsageLimitText(plan, PRO_CEILING, PRO_CEILING, RESET, ORIGIN);
    assertIncludes(text, "Fair-use limit reached", `${plan}: opens as fair use`);
    assertIncludes(text, USAGE_LIMIT_SUPPORT_EMAIL, `${plan}: a support contact the owner can actually write to`);
    assertIncludes(text.toLowerCase(), "safeguard", `${plan}: framed as a safeguard`);
    assertIncludes(text.toLowerCase(), "set far above", `${plan}: the ceiling is described as far above normal use`);
    const lower = text.toLowerCase();
    for (const phrase of ["upgrade", "/pricing", "more actions", "higher plan", "paid plan", "buy", "$5"]) {
      assert(!lower.includes(phrase), `${plan}: message must not sell anything: found ${JSON.stringify(phrase)}`);
    }
  }
});

Deno.test("paid plans never mention the Free grace week", () => {
  const text = buildUsageLimitText("solo", PRO_CEILING, PRO_CEILING, RESET, ORIGIN);
  assert(!text.includes("days after signup"), "grace is a Free fact");
});

// ---------------------------------------------------------------------------
// Plan names
// ---------------------------------------------------------------------------

Deno.test("messages use the plan name the pricing page sells", () => {
  // The internal ids drifted from the marketing names twice: `solo` is now sold
  // as Pro and `pro` as Team. Naming the internal id would send the user looking
  // for a product that does not exist on the pricing page.
  assertIncludes(buildUsageLimitText("solo", 1, 2, RESET, ORIGIN), "Pro plan", "solo renders as Pro");
  assertIncludes(buildUsageLimitText("pro", 1, 2, RESET, ORIGIN), "Team plan", "pro renders as Team");
  assertIncludes(buildUsageLimitText("free", 1, 2, RESET, ORIGIN), "Free plan", "free renders as Free");
});

Deno.test("an unknown plan falls back to the raw id on the paid text", () => {
  // A plan added to the DB before this map is updated must still produce a
  // sentence, not "undefined plan", and must get the conservative (paid,
  // no-upsell) text rather than the Free upgrade pitch.
  const text = buildUsageLimitText("enterprise", 10, 10, RESET, ORIGIN);
  assertIncludes(text, "enterprise plan", "unknown plan id passes through");
  assert(!text.includes("undefined"), "no undefined leaks into user-facing text");
  assert(!text.includes("/pricing"), "an unknown plan is not sold Personal");
});

Deno.test("plan display names cover every plan the allowance function knows", () => {
  // workspace_action_allowance() caps free, personal, solo and pro by name.
  // If one is missing here the message degrades to the raw id.
  for (const plan of ["free", "personal", "solo", "pro"]) {
    assert(typeof PLAN_DISPLAY_NAMES[plan] === "string", `missing display name for ${plan}`);
  }
});

Deno.test("Personal is named by the name it is sold under", () => {
  // `personal` is the one internal id that matches its display name, which
  // makes a missing map entry almost invisible: the fallback prints the raw
  // slug, so the sentence degrades from "Personal plan" to "personal plan" and
  // reads as a typo rather than a bug. Assert the capital.
  const text = buildUsageLimitText("personal", 1, 2, RESET, ORIGIN);
  assertIncludes(text, "Personal plan", "personal renders as Personal");
  assert(!text.includes("personal plan"), "the raw slug must not reach the reader");
  assert(PLAN_DISPLAY_NAMES.personal === "Personal", "Personal needs its own display name entry");
  // Mirror of planDisplayName in apps/web/src/lib/stripe/plans.ts. Both halves
  // of the product show a plan name; they must show the same one.
  assert(PLAN_DISPLAY_NAMES.solo === "Pro" && PLAN_DISPLAY_NAMES.pro === "Team", "the two drifted ids must keep their sold names");
});
