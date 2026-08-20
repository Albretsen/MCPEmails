// ---------------------------------------------------------------------------
// The ceiling message is what a person sees when an automated safeguard stops
// their agent mid-task, and it had no test at all before this file existed.
//
// These assertions are about behaviour, not wording: the numbers must be
// present, the reset date must be unambiguous, the "do not retry" signal must
// survive, the text must not address the model in the imperative, and since the
// 2026-08-19 repricing it must not sell anything, because actions are no longer
// a product. Rewording the sentences is fine. Losing any of those properties
// is not.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import {
  buildUsageLimitText,
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

// The live ceilings, mirrored from SHADOW_ACTION_CAPS in index.ts.
const FREE_CEILING = 5_000;
const PRO_CEILING = 100_000;

Deno.test("ceiling message leads with the numbers the user needs", () => {
  const text = buildUsageLimitText("free", FREE_CEILING, FREE_CEILING, "2026-09-01T00:00:00.000Z", ORIGIN);
  assertIncludes(text, "5,000 of 5,000", "used and cap, thousand-separated");
  // Leading with them is the point: they have to survive a truncating client
  // and a paraphrasing model.
  assert(text.indexOf("5,000 of 5,000") < 60, "numbers must appear in the first clause");
});

Deno.test("ceiling message states the reset date in unambiguous ISO order", () => {
  const text = buildUsageLimitText("free", FREE_CEILING, FREE_CEILING, "2026-09-01T00:00:00.000Z", ORIGIN);
  assertIncludes(text, "2026-09-01", "reset date");
  assert(!text.includes("T00:00:00"), "the time component is noise for a human reader");
});

Deno.test("ceiling message tells the agent not to retry", () => {
  const text = buildUsageLimitText("solo", PRO_CEILING, PRO_CEILING, "2026-09-14T00:00:00.000Z", ORIGIN);
  // An agent's default reflex on an unclassified failure is retry-with-backoff.
  // A per-period ceiling cannot clear for days, so this phrase is what stops the
  // loop on clients that never surface a numeric error code at all.
  assertIncludes(text.toLowerCase(), "retrying will not help", "explicit non-retryable signal");
  assertIncludes(text.toLowerCase(), "not a temporary failure", "rules out transient-failure reading");
});

Deno.test("ceiling message uses the plan name the pricing page sells", () => {
  // The internal ids drifted from the marketing names twice: `solo` is now sold
  // as Pro and `pro` as Team. Naming the internal id would send the user looking
  // for a product that does not exist on the pricing page.
  assertIncludes(buildUsageLimitText("solo", 1, 2, "2026-09-01T00:00:00Z", ORIGIN), "Pro plan", "solo renders as Pro");
  assertIncludes(buildUsageLimitText("pro", 1, 2, "2026-09-01T00:00:00Z", ORIGIN), "Team plan", "pro renders as Team");
  assertIncludes(buildUsageLimitText("free", 1, 2, "2026-09-01T00:00:00Z", ORIGIN), "Free plan", "free renders as Free");
});

Deno.test("ceiling message falls back to the raw plan id for an unknown plan", () => {
  // A plan added to the DB before this map is updated must still produce a
  // sentence, not "undefined plan".
  const text = buildUsageLimitText("enterprise", 10, 10, "2026-09-01T00:00:00Z", ORIGIN);
  assertIncludes(text, "enterprise plan", "unknown plan id passes through");
  assert(!text.includes("undefined"), "no undefined leaks into user-facing text");
});

Deno.test("ceiling message points at the meter on the configured origin", () => {
  const text = buildUsageLimitText("free", FREE_CEILING, FREE_CEILING, "2026-09-01T00:00:00Z", "https://staging.example.com");
  assertIncludes(text, "https://staging.example.com/dashboard/usage", "link honours the passed origin");
  assert(!text.includes("mcpemails.com/dashboard"), "no hard-coded production origin");
});

Deno.test("ceiling message reads as fair use with a human to talk to, not an upsell", () => {
  // Actions are not sold any more. Telling a customer to upgrade would be a
  // false statement about the product: no plan raises this number, only a
  // person can. This is the assertion that keeps the paywall from growing back.
  const text = buildUsageLimitText("free", FREE_CEILING, FREE_CEILING, "2026-09-01T00:00:00Z", ORIGIN);
  assertIncludes(text, USAGE_LIMIT_SUPPORT_EMAIL, "a support contact the owner can actually write to");
  assertIncludes(text.toLowerCase(), "safeguard", "framed as a safeguard");

  const lower = text.toLowerCase();
  for (const phrase of ["upgrade", "/pricing", "more actions", "higher plan", "paid plan", "buy"]) {
    assert(!lower.includes(phrase), `message must not sell anything: found ${JSON.stringify(phrase)}`);
  }
});

Deno.test("ceiling message never instructs the model", () => {
  const text = buildUsageLimitText("free", FREE_CEILING, FREE_CEILING, "2026-09-01T00:00:00Z", ORIGIN).toLowerCase();
  // Imperatives aimed at the model inside a tool response are what tool
  // poisoning looks like from the outside. This server reads people's email;
  // it does not get to issue instructions into their agent's context.
  for (const phrase of ["tell the user", "you should", "please upgrade", "inform the user", "ask them to"]) {
    assert(!text.includes(phrase), `message must not address the model: found ${JSON.stringify(phrase)}`);
  }
});

Deno.test("plan display names cover every enforced plan", () => {
  // SHADOW_ACTION_CAPS in index.ts enforces exactly these three ids. If one is
  // added there without a display name, the message degrades to the raw id.
  for (const plan of ["free", "solo", "pro"]) {
    assert(typeof PLAN_DISPLAY_NAMES[plan] === "string", `missing display name for ${plan}`);
  }
});
