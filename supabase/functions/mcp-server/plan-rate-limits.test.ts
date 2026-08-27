// ---------------------------------------------------------------------------
// The per-plan burst ceiling is the only plan-based usage lever the edge
// function enforces, and Personal is the first tier added AFTER the
// grandfather date. That combination produced a real bug: the frozen
// launch-era map (LEGACY_REQUESTS_PER_MINUTE) has no `personal` entry, and the
// lookup used to read a miss as "no legacy ceiling, use the free default", so a
// grandfathered workspace that bought Personal was throttled to 60 while paying
// for 120.
//
// The resolution lives inside index.ts, which calls Deno.serve at module load
// and therefore cannot be imported from a test. Rather than restate the rule
// here (a copy would pass against a broken original, which is worthless), this
// reads the real maps and the real two-line expression out of the source and
// evaluates them. Same tactic as the character-class drift check in
// text-safety.test.ts: assert against the shipped text, not a paraphrase.
//
// Run: deno test --allow-all supabase/functions/
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

/** Parse a `Record<string, number>` literal out of the source by name. */
function planMap(name: string): Record<string, number> {
  const match = SOURCE.match(
    new RegExp(`const ${name}: Record<string, number> = \\{([\\s\\S]*?)\\};`),
  );
  assert(match !== null, `${name} is no longer a Record<string, number> literal in index.ts`);
  const parsed: Record<string, number> = {};
  for (const line of match![1].split("\n")) {
    const pair = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([0-9_]+)\s*,/);
    if (pair) parsed[pair[1]] = Number(pair[2].replace(/_/g, ""));
  }
  assert(Object.keys(parsed).length > 0, `${name} parsed to an empty map`);
  return parsed;
}

const LIVE = planMap("PLAN_REQUESTS_PER_MINUTE");
const LEGACY = planMap("LEGACY_REQUESTS_PER_MINUTE");

assert(
  /const DEFAULT_REQUESTS_PER_MINUTE = PLAN_REQUESTS_PER_MINUTE\.free;/.test(SOURCE),
  "the unknown-plan default is no longer the free ceiling; this test's wiring is stale",
);

/**
 * The shipped resolution, lifted verbatim from checkPlanQuota and made callable.
 * If the two statements are reworded, this throws rather than silently testing
 * a rule that is no longer in the file.
 */
const expression = SOURCE.match(
  /const legacyLimit = [\s\S]*?;\s*const perMinuteLimit = [\s\S]*?;/,
);
assert(expression !== null, "checkPlanQuota no longer resolves via legacyLimit / perMinuteLimit");

const resolve = new Function(
  "PLAN_REQUESTS_PER_MINUTE",
  "LEGACY_REQUESTS_PER_MINUTE",
  "DEFAULT_REQUESTS_PER_MINUTE",
  "plan",
  "grandfathered",
  `${expression![0]}\nreturn perMinuteLimit;`,
) as (
  live: Record<string, number>,
  legacy: Record<string, number>,
  fallback: number,
  plan: string,
  grandfathered: boolean,
) => number;

const rpm = (plan: string, grandfathered: boolean) =>
  resolve(LIVE, LEGACY, LIVE.free, plan, grandfathered);

Deno.test("Personal is worth 120 requests a minute, twice the free ceiling", () => {
  assertEquals(LIVE.personal, 120, "the live map must price Personal at 120");
  assertEquals(rpm("personal", false), 120, "a Personal workspace resolves its own ceiling");
  assertEquals(rpm("free", false), 60, "Free is unchanged");
  assertEquals(rpm("solo", false), 300, "Pro is unchanged");
  assertEquals(rpm("pro", false), 1000, "Team is unchanged");
});

Deno.test("a grandfathered workspace on Personal gets 120, not the free 60", () => {
  // The bug this file exists for. `personal` is deliberately absent from the
  // frozen launch-era map (no workspace was ever grandfathered onto a plan that
  // did not exist yet), so the miss has to fall through to the live map.
  assert(
    !Object.hasOwn(LEGACY, "personal"),
    "seeding Personal into the frozen legacy map freezes a launch-era value for a plan with no launch-era history",
  );
  assertEquals(rpm("personal", true), 120, "a grandfathered Personal customer must get what they pay for");
});

Deno.test("the frozen map still wins for the plans that do have launch-era ceilings", () => {
  // The fall-through must not turn into "always use the live map": that would
  // silently cut a grandfathered workspace the day a ceiling is lowered.
  for (const plan of ["free", "solo", "pro", "enterprise"]) {
    assertEquals(rpm(plan, true), LEGACY[plan], `${plan} must keep its frozen legacy ceiling`);
  }
});

Deno.test("an unknown plan id still lands on the free default", () => {
  assertEquals(rpm("enterprise_v2", false), 60, "unknown plans are throttled, not opened up");
  assertEquals(rpm("enterprise_v2", true), 60, "an unknown plan gets no grandfather bonus either");
});
