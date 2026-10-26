import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMonthSummarySentence,
  buildUsageMeterNote,
  frameCapRefusal,
  loadCapSummary,
  maybeAttachUsageMeterNote,
  type MeterReading,
  usageMeterLevel,
} from "./usage-meter-note.ts";
import { buildUsageLimitText } from "./usage-limit-message.ts";

const ORIGIN = "https://mcpemails.com";
const reading = (used: number, cap = 150, plan = "free"): MeterReading => ({
  plan,
  usedActions: used,
  cap,
  periodStart: "2026-11-01T00:00:00Z",
  periodEnd: "2026-12-01T00:00:00Z",
});

function fakeDb(answers: Record<string, unknown>, calls: Array<[string, Record<string, unknown>]> = []) {
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push([fn, args]);
      const answer = answers[fn];
      if (answer instanceof Error) return Promise.resolve({ data: null, error: { message: answer.message } });
      return Promise.resolve({ data: answer ?? null, error: null });
    },
  };
}

Deno.test("usageMeterLevel: 80 from the 80% line, 100 on the last action, nothing below", () => {
  assertEquals(usageMeterLevel(119, 150), null);
  assertEquals(usageMeterLevel(120, 150), 80);
  assertEquals(usageMeterLevel(149, 150), 80);
  assertEquals(usageMeterLevel(150, 150), 100);
  assertEquals(usageMeterLevel(10, 0), null);
  assertEquals(usageMeterLevel(Number.NaN, 150), null);
});

Deno.test("usage line: Claude and others get the plan, both prices and one link", () => {
  const text = buildUsageMeterNote(80, reading(120), "standard", ORIGIN);
  assertStringIncludes(text, "120 of the 150 email actions");
  assertStringIncludes(text, "2026-12-01");
  assertStringIncludes(text, "$9 per month");
  assertStringIncludes(text, "$86.40 per year");
  assertStringIncludes(text, `${ORIGIN}/pricing?from=usage_meter`);
  assert(!text.includes("—"), "no em dash");
});

Deno.test("usage line: OpenAI (directory) gets the fact only, never a plan, price or link", () => {
  for (const level of [80, 100] as const) {
    const text = buildUsageMeterNote(level, reading(level === 100 ? 150 : 120), "directory", ORIGIN);
    assert(!text.includes("$"), text);
    assert(!text.includes("Personal"), text);
    assert(!text.includes("http"), text);
  }
});

Deno.test("usage line at 100% says the last action was used and when it resets", () => {
  const text = buildUsageMeterNote(100, reading(150), "standard", ORIGIN);
  assertStringIncludes(text, "used the last of the 150 email actions");
  assertStringIncludes(text, "refused until the counter resets on 2026-12-01");
});

Deno.test("maybeAttachUsageMeterNote: no query below 80%, on a failed call, or on a paid plan", async () => {
  for (const [r, succeeded] of [[reading(100), true], [reading(130), false], [reading(130, 150, "personal"), true]] as const) {
    const db = fakeDb({ claim_usage_meter_note: true });
    const notes: string[] = [];
    const attached = await maybeAttachUsageMeterNote({
      db, workspaceId: "w", reading: r, succeeded, wording: () => Promise.resolve("standard"),
      appOrigin: ORIGIN, attach: (n) => notes.push(n), log: () => {},
    });
    assertEquals(attached, false);
    assertEquals(db.calls.length, 0);
    assertEquals(notes.length, 0);
  }
});

Deno.test("maybeAttachUsageMeterNote: attaches only when the claim answers true", async () => {
  const claimed = fakeDb({ claim_usage_meter_note: true });
  const notes: string[] = [];
  assertEquals(await maybeAttachUsageMeterNote({
    db: claimed, workspaceId: "w", reading: reading(121), succeeded: true,
    wording: () => Promise.resolve("directory"), appOrigin: ORIGIN, attach: (n) => notes.push(n), log: () => {},
  }), true);
  assertEquals(claimed.calls[0], ["claim_usage_meter_note", { p_workspace_id: "w", p_level: 80, p_period_start: "2026-11-01T00:00:00Z" }]);
  assertEquals(notes.length, 1);
  assert(!notes[0].includes("$"));

  const notClaimed = fakeDb({ claim_usage_meter_note: false });
  const none: string[] = [];
  assertEquals(await maybeAttachUsageMeterNote({
    db: notClaimed, workspaceId: "w", reading: reading(150), succeeded: true,
    wording: () => Promise.resolve("standard"), appOrigin: ORIGIN, attach: (n) => none.push(n), log: () => {},
  }), false);
  assertEquals(none.length, 0);
});

Deno.test("maybeAttachUsageMeterNote never throws on a failed claim", async () => {
  const db = fakeDb({ claim_usage_meter_note: new Error("boom") });
  const events: string[] = [];
  assertEquals(await maybeAttachUsageMeterNote({
    db, workspaceId: "w", reading: reading(150), succeeded: true,
    wording: () => Promise.resolve("standard"), appOrigin: ORIGIN, attach: () => {}, log: (e) => events.push(e),
  }), false);
  assertEquals(events, ["usage_meter_note_failed"]);
});

Deno.test("month summary sentence lists only what happened", () => {
  assertEquals(buildMonthSummarySentence({ reads: 0, drafts: 0, sends: 0 }), null);
  assertEquals(buildMonthSummarySentence(null), null);
  assertEquals(buildMonthSummarySentence({ reads: 42, drafts: 0, sends: 0 }), "This month MCPEmails read 42 emails for this workspace.");
  assertEquals(
    buildMonthSummarySentence({ reads: 42, drafts: 1, sends: 5 }),
    "This month MCPEmails read 42 emails, wrote 1 draft and sent 5 emails for this workspace.",
  );
});

Deno.test("frameCapRefusal: achievements first, existing text unchanged, annual second", () => {
  const base = buildUsageLimitText("free", 150, 150, "2026-12-01T00:00:00Z", ORIGIN, "standard");
  const framed = frameCapRefusal(base, { reads: 10, drafts: 2, sends: 1 }, "standard", ORIGIN);
  assert(framed.startsWith("This month MCPEmails read 10 emails"), framed);
  assertStringIncludes(framed, base);
  assert(framed.indexOf("$9 per month") < framed.indexOf("$86.40 per year"), "monthly first, annual second");
  // Not in Flow B: byte for byte what it was.
  assertEquals(frameCapRefusal(base, null, "standard", ORIGIN), base);
  // OpenAI: achievements yes, prices no.
  const dir = buildUsageLimitText("free", 150, 150, "2026-12-01T00:00:00Z", ORIGIN, "directory");
  const framedDir = frameCapRefusal(dir, { reads: 3, drafts: 0, sends: 0 }, "directory", ORIGIN);
  assert(framedDir.startsWith("This month MCPEmails read 3 emails"));
  assert(!framedDir.includes("$"), framedDir);
});

Deno.test("loadCapSummary: null outside Flow B, counts inside, null on errors", async () => {
  assertEquals(await loadCapSummary(fakeDb({ onboarding_convert_on: false }), "w", "2026-11-01", () => {}), null);
  assertEquals(
    await loadCapSummary(fakeDb({ onboarding_convert_on: true, usage_month_summary: [{ reads: 4, drafts: 2, sends: 1 }] }), "w", "2026-11-01", () => {}),
    { reads: 4, drafts: 2, sends: 1 },
  );
  assertEquals(await loadCapSummary(fakeDb({ onboarding_convert_on: new Error("x") }), "w", "2026-11-01", () => {}), null);
});
