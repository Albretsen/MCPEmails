// ---------------------------------------------------------------------------
// The cap message is the product's only paywall, and it had no test at all.
//
// These assertions are about behaviour, not wording: the numbers must be
// present, the reset date must be unambiguous, the "do not retry" signal must
// survive, and the text must not address the model in the imperative. Rewording
// the sentences is fine. Losing any of those four properties is not.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { buildUsageLimitText, PLAN_DISPLAY_NAMES } from "./usage-limit-message.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}: expected to find ${JSON.stringify(needle)} in ${JSON.stringify(haystack)}`);
  }
}

const ORIGIN = "https://mcpemails.com";

Deno.test("cap message leads with the numbers the user needs", () => {
  const text = buildUsageLimitText("free", 2500, 2500, "2026-09-01T00:00:00.000Z", ORIGIN);
  assertIncludes(text, "2,500 of 2,500", "used and cap, thousand-separated");
  // Leading with them is the point: they have to survive a truncating client
  // and a paraphrasing model.
  assert(text.indexOf("2,500 of 2,500") < 60, "numbers must appear in the first clause");
});

Deno.test("cap message states the reset date in unambiguous ISO order", () => {
  const text = buildUsageLimitText("free", 2500, 2500, "2026-09-01T00:00:00.000Z", ORIGIN);
  assertIncludes(text, "2026-09-01", "reset date");
  assert(!text.includes("T00:00:00"), "the time component is noise for a human reader");
});

Deno.test("cap message tells the agent not to retry", () => {
  const text = buildUsageLimitText("solo", 50000, 50000, "2026-09-14T00:00:00.000Z", ORIGIN);
  // An agent's default reflex on an unclassified failure is retry-with-backoff.
  // A monthly cap cannot clear for days, so this phrase is what stops the loop
  // on clients that never surface a numeric error code at all.
  assertIncludes(text.toLowerCase(), "retrying will not help", "explicit non-retryable signal");
  assertIncludes(text.toLowerCase(), "not a temporary failure", "rules out transient-failure reading");
});

Deno.test("cap message uses the plan name the pricing page sells", () => {
  // The internal ids drifted from the marketing names: `solo` is sold as Agent,
  // `pro` as Scale. Naming the internal id would send the user looking for a
  // product that does not exist on the pricing page.
  assertIncludes(buildUsageLimitText("solo", 1, 2, "2026-09-01T00:00:00Z", ORIGIN), "Agent plan", "solo renders as Agent");
  assertIncludes(buildUsageLimitText("pro", 1, 2, "2026-09-01T00:00:00Z", ORIGIN), "Scale plan", "pro renders as Scale");
  assertIncludes(buildUsageLimitText("free", 1, 2, "2026-09-01T00:00:00Z", ORIGIN), "Free plan", "free renders as Free");
});

Deno.test("cap message falls back to the raw plan id for an unknown plan", () => {
  // A plan added to the DB before this map is updated must still produce a
  // sentence, not "undefined plan".
  const text = buildUsageLimitText("enterprise", 10, 10, "2026-09-01T00:00:00Z", ORIGIN);
  assertIncludes(text, "enterprise plan", "unknown plan id passes through");
  assert(!text.includes("undefined"), "no undefined leaks into user-facing text");
});

Deno.test("cap message points at the meter on the configured origin", () => {
  const text = buildUsageLimitText("free", 2500, 2500, "2026-09-01T00:00:00Z", "https://staging.example.com");
  assertIncludes(text, "https://staging.example.com/dashboard/usage", "link honours the passed origin");
  assert(!text.includes("mcpemails.com"), "no hard-coded production origin");
});

Deno.test("cap message never instructs the model", () => {
  const text = buildUsageLimitText("free", 2500, 2500, "2026-09-01T00:00:00Z", ORIGIN).toLowerCase();
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
