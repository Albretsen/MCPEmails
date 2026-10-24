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

// ---------------------------------------------------------------------------
// Per-key windows follow the plan (2026-10-24, developer API plan finding F1).
//
// The per-key windows used to be 100/min, 1000/hr, 10000/day on every plan, so
// one Pro key stopped at 100 while the workspace ceiling said 300, and the
// plan's burst was reachable only with three or more keys. Same tactic as
// above: the window tables and the scaling functions are read out of the
// shipped source and evaluated, never restated.
// ---------------------------------------------------------------------------

interface Window {
  label: string;
  intervalMs: number;
  limit: number;
}

interface CheapLimit {
  label: string;
  bucket: string;
  max: number;
  windowMs: number;
}

/** Parse an array-of-object-literals constant out of the source by name. */
function objectTable(name: string, type: string): Record<string, string | number>[] {
  const match = SOURCE.match(new RegExp(`const ${name}: ${type}\\[\\] = \\[([\\s\\S]*?)\\];`));
  assert(match !== null, `${name} is no longer a ${type}[] literal in index.ts`);
  const rows: Record<string, string | number>[] = [];
  for (const object of match![1].matchAll(/\{([^{}]*)\}/g)) {
    const row: Record<string, string | number> = {};
    for (const field of object[1].matchAll(/([A-Za-z]+):\s*("([^"]*)"|[0-9_]+)/g)) {
      row[field[1]] = field[3] !== undefined ? field[3] : Number(field[2].replace(/_/g, ""));
    }
    rows.push(row);
  }
  assert(rows.length > 0, `${name} parsed to an empty table`);
  return rows;
}

const WINDOWS = objectTable("RATE_LIMIT_WINDOWS", "WindowDefinition") as unknown as Window[];
const DISCOVERY = objectTable("DISCOVERY_RATE_LIMITS", "SlidingWindowLimit") as unknown as CheapLimit[];
const RESOURCES = objectTable("RESOURCE_RATE_LIMITS", "SlidingWindowLimit") as unknown as CheapLimit[];

/** The body of a named function in index.ts, which must carry no type syntax. */
function functionBody(signature: RegExp, name: string): string {
  const match = SOURCE.match(new RegExp(`${signature.source} \\{\\n([\\s\\S]*?)\\n\\}\\n`));
  assert(match !== null, `${name} is no longer in index.ts in the expected shape`);
  return match![1];
}

const factorBody = functionBody(
  /function perKeyPlanFactor\(perMinuteCeiling: number\): number/,
  "perKeyPlanFactor",
);
const windowsBody = functionBody(
  /function perKeyWindows\(perMinuteCeiling: number\): WindowDefinition\[\]/,
  "perKeyWindows",
);
const cheapBody = functionBody(
  /function planScaledLimits\(limits: SlidingWindowLimit\[\], perMinuteCeiling: number\): SlidingWindowLimit\[\]/,
  "planScaledLimits",
);

const perKeyPlanFactor = new Function("RATE_LIMIT_WINDOWS", "perMinuteCeiling", factorBody) as (
  windows: Window[],
  ceiling: number,
) => number;
const factor = (ceiling: number) => perKeyPlanFactor(WINDOWS, ceiling);
const perKeyWindows = (ceiling: number): Window[] =>
  (new Function("RATE_LIMIT_WINDOWS", "perKeyPlanFactor", "perMinuteCeiling", windowsBody))(
    WINDOWS,
    factor,
    ceiling,
  );
const planScaledLimits = (limits: CheapLimit[], ceiling: number): CheapLimit[] =>
  (new Function("perKeyPlanFactor", "limits", "perMinuteCeiling", cheapBody))(factor, limits, ceiling);

const windowLimit = (windows: Window[], label: string) => windows.find((w) => w.label === label)!.limit;

Deno.test("the base per-key windows are unchanged", () => {
  assertEquals(windowLimit(WINDOWS, "per_minute"), 100, "base minute window");
  assertEquals(windowLimit(WINDOWS, "per_hour"), 1000, "base hour window");
  assertEquals(windowLimit(WINDOWS, "per_day"), 10000, "base day window");
});

Deno.test("a single Pro key reaches the 300 a minute its plan sells", () => {
  const pro = perKeyWindows(rpm("solo", false));
  assertEquals(windowLimit(pro, "per_minute"), 300, "Pro minute window");
  assertEquals(windowLimit(pro, "per_hour"), 3000, "Pro hour window scales by the same factor");
  assertEquals(windowLimit(pro, "per_day"), 30000, "Pro day window scales by the same factor");
});

Deno.test("a single Business key reaches 1000 a minute", () => {
  const business = perKeyWindows(rpm("pro", false));
  assertEquals(windowLimit(business, "per_minute"), 1000, "Business minute window");
  assertEquals(windowLimit(business, "per_hour"), 10000, "Business hour window");
  assertEquals(windowLimit(business, "per_day"), 100000, "Business day window");
});

Deno.test("Personal gets 120, and Free never drops below the base windows", () => {
  const personal = perKeyWindows(rpm("personal", false));
  assertEquals(windowLimit(personal, "per_minute"), 120, "Personal minute window");
  assertEquals(windowLimit(personal, "per_hour"), 1200, "Personal hour window");
  const free = perKeyWindows(rpm("free", false));
  for (const w of WINDOWS) {
    assertEquals(windowLimit(free, w.label), w.limit, `Free ${w.label} stays at the base value`);
  }
  // A grandfathered workspace scales off the same resolution, legacy map included.
  assertEquals(windowLimit(perKeyWindows(rpm("solo", true)), "per_minute"), LEGACY.solo, "grandfathered Pro");
  assertEquals(windowLimit(perKeyWindows(rpm("personal", true)), "per_minute"), 120, "grandfathered Personal");
});

Deno.test("the per-key limiter is handed the ceiling checkPlanQuota resolves, from the same read", () => {
  assert(
    /checkPlanQuota\(apiKey\.workspace_id, preloaded\?\.planQuota, settleKeyCeiling\)/.test(SOURCE),
    "the tools/call path must pass the ceiling sink into checkPlanQuota",
  );
  assert(
    /checkRateLimit\(apiKey\.id, preloaded\?\.rateLimit, keyCeiling\)/.test(SOURCE),
    "the tools/call path must pass the plan ceiling into checkRateLimit",
  );
  assert(
    /const windows = perKeyWindows\(await perMinuteCeiling\);/.test(SOURCE) &&
      /for \(const \[index, window\] of windows\.entries\(\)\)/.test(SOURCE),
    "checkRateLimit must judge its counts against the plan-scaled windows",
  );
  assert(/onCeiling\?\.\(perMinuteLimit\);/.test(SOURCE), "checkPlanQuota reports the resolved ceiling");
});

Deno.test("discovery and resource ceilings stay above tools/call times the re-handshake ratio on every plan", () => {
  // ChatGPT and Notion re-handshake about 2.2 times per tools/call (measured in
  // prod). The cheap-method ceilings must sit above that on every plan, or a
  // paid session is throttled on discovery before its own tools/call budget.
  const RATIO = 2.2;
  for (const plan of ["free", "personal", "solo", "pro"]) {
    const ceiling = rpm(plan, false);
    const keyWindows = perKeyWindows(ceiling);
    const discovery = planScaledLimits(DISCOVERY, ceiling);
    const resources = planScaledLimits(RESOURCES, ceiling);
    for (const label of ["per_minute", "per_hour"]) {
      const toolCalls = windowLimit(keyWindows, label);
      const d = discovery.find((w) => w.label === label)!.max;
      const r = resources.find((w) => w.label === label)!.max;
      assert(d >= toolCalls * RATIO, `${plan} discovery ${label} ${d} < ${toolCalls} x ${RATIO}`);
      assert(r > toolCalls, `${plan} resources ${label} ${r} must exceed tools/call ${toolCalls}`);
    }
  }
  assertEquals(planScaledLimits(DISCOVERY, rpm("free", false))[0].max, DISCOVERY[0].max, "Free discovery minute");
  assert(
    /checkCheapMethodRateLimit\(apiKey, isResourceMethod\)/.test(SOURCE),
    "the cheap-method gate must use the plan-scaled tables",
  );
});
