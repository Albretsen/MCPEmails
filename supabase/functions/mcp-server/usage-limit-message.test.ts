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
  FREE_CAP_UPGRADE_PRICE,
  freeCapUpgradeUrl,
  PLAN_DISPLAY_NAMES,
  USAGE_LIMIT_SUPPORT_EMAIL,
  plansInfoUrl,
  rateLimitPlanSentence,
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
  assert(FREE_ACTION_GRACE_DAYS === 3, "the grace constant mirrors free_action_grace_ends_at() for new workspaces");
});

Deno.test("Free says what keeps working", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(text, "inbox_list and the dashboard keep working", "the non-billable tool and the dashboard are named");
});

Deno.test("Free carries the upgrade URL with its funnel tag and the price", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN);
  assertIncludes(text, `${ORIGIN}${FREE_CAP_UPGRADE_PATH}`, "upgrade link on the passed origin");
  assertIncludes(text, FREE_CAP_UPGRADE_PRICE, "the price is stated, not left to be discovered");
  // Personal is $9 a month since 2026-09-29. apps/web's personal-price-copy
  // test pins this constant to PLANS.personal.monthlyPriceCents.
  assert(FREE_CAP_UPGRADE_PRICE === "$9 per month", "the quoted price is Personal's monthly price");
  assertIncludes(text, "Personal plan removes the monthly cap", "the true remedy is named as a fact");
  assert(FREE_CAP_UPGRADE_PATH.includes("from=usage_cap"), "the funnel tag tells this door apart");
  assert(freeCapUpgradeUrl("https://x.test") === "https://x.test/pricing?from=usage_cap", "helper builds the same URL");
});

// ---------------------------------------------------------------------------
// Directory wording: OpenAI's plugin guidelines allow explaining a plan limit
// and linking to an informational plans page, and forbid quoting prices or
// promoting an upgrade. ChatGPT and Codex clients get this wording.
// ---------------------------------------------------------------------------

Deno.test("directory wording explains the Free limit without a price, a plan to buy or an upgrade pitch", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN, "directory");
  // The facts the person needs are all still there.
  assertIncludes(text, "Monthly allowance reached", "the limit is still named");
  assertIncludes(text, "retrying will not help", "the retry loop is still stopped");
  assertIncludes(text, "inbox_list and the dashboard keep working", "what keeps working is still said");
  assertIncludes(text, `${ORIGIN}/dashboard/usage`, "the meter link is kept");
  assertIncludes(text, `${plansInfoUrl(ORIGIN)}.`, "one informational link to the plans page");
  assert(plansInfoUrl("https://x.test") === "https://x.test/pricing", "the plans link carries no funnel tag");
  for (const phrase of [FREE_CAP_UPGRADE_PRICE, "$", "per month", "upgrade", "Personal", "removes the monthly cap", "from=usage_cap"]) {
    assert(!text.toLowerCase().includes(phrase.toLowerCase()), `directory wording must not contain "${phrase}"`);
  }
});

Deno.test("directory wording leaves the paid fair-use text exactly as it is", () => {
  for (const plan of ["personal", "solo", "pro"]) {
    assert(
      buildUsageLimitText(plan, 10, 10, RESET, ORIGIN, "directory") === buildUsageLimitText(plan, 10, 10, RESET, ORIGIN),
      `${plan}: nothing is sold there, so there is nothing to neutralise`,
    );
  }
});

Deno.test("standard wording is the default and is unchanged", () => {
  assert(
    buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN, "standard") ===
      buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN),
    "omitting the argument means standard",
  );
});

Deno.test("standard and directory Free wording are byte-identical to before the checkout wording existed", () => {
  // Snapshots taken from the module as it stood at ba554a8e. Adding a wording
  // must not move a single byte of the two that every client sees today.
  const standard =
    "Monthly allowance reached: 150 of 150 email actions used this month on the Free plan. The counter resets on 2026-10-01. Until then every email action in this workspace will be refused, so retrying will not help: this is a plan limit, not a temporary failure. The Free plan includes 150 email actions per calendar month; the first 3 days after signup are not counted. inbox_list and the dashboard keep working. The Personal plan removes the monthly cap for $9 per month at https://mcpemails.com/pricing?from=usage_cap. The current count is at https://mcpemails.com/dashboard/usage.";
  const directory =
    "Monthly allowance reached: 150 of 150 email actions used this month on the Free plan. The counter resets on 2026-10-01. Until then every email action in this workspace will be refused, so retrying will not help: this is a plan limit, not a temporary failure. The Free plan includes 150 email actions per calendar month; the first 3 days after signup are not counted. inbox_list and the dashboard keep working. The plans and what each includes are described at https://mcpemails.com/pricing. The current count is at https://mcpemails.com/dashboard/usage.";
  assert(buildUsageLimitText("free", 150, 150, RESET, ORIGIN) === standard, "standard snapshot");
  assert(buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "standard", CHECKOUT) === standard, "a link passed with standard wording is ignored");
  assert(buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "directory") === directory, "directory snapshot");
  assert(buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "directory", CHECKOUT) === directory, "a link passed with directory wording is ignored");
});

// ---------------------------------------------------------------------------
// Checkout wording: standard plus a 30-minute link straight to checkout, for a
// Free owner on a non-OpenAI client (checkout-link.ts decides).
// ---------------------------------------------------------------------------

const CHECKOUT = { url: `${ORIGIN}/u/${"A".repeat(43)}`, minutes: 30 };

Deno.test("checkout wording leads with the numbers and carries the link and its lifetime", () => {
  const text = buildUsageLimitText("free", FREE_ALLOWANCE, FREE_ALLOWANCE, RESET, ORIGIN, "checkout", CHECKOUT);
  assert(text.startsWith("Monthly allowance reached: 150 of 150 email actions"), "numbers first");
  assertIncludes(text, "2026-10-01", "reset date");
  assertIncludes(text, CHECKOUT.url, "the link");
  assertIncludes(text, "for the next 30 minutes", "its lifetime");
  assertIncludes(text, "signs nobody in", "says what the link does not do");
  assertIncludes(text, FREE_CAP_UPGRADE_PRICE, "the price");
  assertIncludes(text, "Personal plan removes the monthly cap", "the remedy as a fact");
  assertIncludes(text, "the same request succeeds", "what happens after paying");
  assertIncludes(text, `${plansInfoUrl(ORIGIN)}.`, "all plans");
  assertIncludes(text, `${ORIGIN}/dashboard/usage`, "the meter");
  assertIncludes(text, `first ${FREE_ACTION_GRACE_DAYS} days after signup are not counted`, "grace");
  assertIncludes(text, "inbox_list and the dashboard keep working", "what keeps working");
  const lower = text.toLowerCase();
  assertIncludes(lower, "retrying will not help", "retry loop stopped");
  assertIncludes(lower, "not a temporary failure", "not transient");
  assertIncludes(lower, "plan limit", "framed as a plan limit");
  assert(text.indexOf(CHECKOUT.url) === text.lastIndexOf(CHECKOUT.url), "one link to checkout, once");
});

Deno.test("checkout wording never instructs the model", () => {
  const text = buildUsageLimitText("free", 10, 10, RESET, ORIGIN, "checkout", CHECKOUT).toLowerCase();
  for (
    const phrase of [
      "tell the user", "you should", "please upgrade", "inform the user", "ask them to", "ask the user",
      "suggest", "recommend", "encourage", "remind the user", "click", "share this",
    ]
  ) {
    assert(!text.includes(phrase), `checkout must not address the model: found ${JSON.stringify(phrase)}`);
  }
});

Deno.test("checkout wording prints the minutes it is handed, for a reused link", () => {
  const text = buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "checkout", { url: CHECKOUT.url, minutes: 7 });
  assertIncludes(text, "for the next 7 minutes", "minutes left");
  assert(!text.includes("30 minutes"), "not the full lifetime");
  assertIncludes(
    buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "checkout", { url: CHECKOUT.url, minutes: 1 }),
    "for the next 1 minute;",
    "singular",
  );
});

Deno.test("checkout wording without a link is exactly standard", () => {
  const standard = buildUsageLimitText("free", 150, 150, RESET, ORIGIN);
  assert(buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "checkout") === standard, "no argument");
  assert(buildUsageLimitText("free", 150, 150, RESET, ORIGIN, "checkout", null) === standard, "null");
});

Deno.test("checkout wording leaves the paid fair-use text exactly as it is", () => {
  for (const plan of ["personal", "solo", "pro"]) {
    assert(
      buildUsageLimitText(plan, 10, 10, RESET, ORIGIN, "checkout", CHECKOUT) === buildUsageLimitText(plan, 10, 10, RESET, ORIGIN),
      `${plan}: no link on a paid ceiling`,
    );
  }
});

Deno.test("directory wording never carries a checkout path or a price, whatever it is handed", () => {
  for (const plan of ["free", "personal", "solo", "pro"]) {
    const text = buildUsageLimitText(plan, 150, 150, RESET, ORIGIN, "directory", CHECKOUT);
    assert(!text.includes("/u/"), `${plan}: no checkout link in directory wording`);
    assert(!text.includes("$"), `${plan}: no price in directory wording`);
  }
});

Deno.test("the rate-limit refusal drops its plan sentence for directory clients only", () => {
  assert(rateLimitPlanSentence("directory") === "", "waiting is the whole remedy");
  assertIncludes(rateLimitPlanSentence("standard"), "https://www.mcpemails.com/pricing", "standard keeps its link");
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
    const personalPrice = FREE_CAP_UPGRADE_PRICE.split(" ")[0];
    for (const phrase of ["upgrade", "/pricing", "more actions", "higher plan", "paid plan", "buy", personalPrice]) {
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
  // as Pro and `pro` as Business. Naming the internal id would send the user looking
  // for a product that does not exist on the pricing page.
  assertIncludes(buildUsageLimitText("solo", 1, 2, RESET, ORIGIN), "Pro plan", "solo renders as Pro");
  assertIncludes(buildUsageLimitText("pro", 1, 2, RESET, ORIGIN), "Business plan", "pro renders as Business");
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
  assert(PLAN_DISPLAY_NAMES.solo === "Pro" && PLAN_DISPLAY_NAMES.pro === "Business", "the two drifted ids must keep their sold names");
});
