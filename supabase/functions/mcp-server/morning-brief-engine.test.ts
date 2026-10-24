// ---------------------------------------------------------------------------
// morning-brief-engine.ts: time zone and DST math, settings rules, the content
// builder (golden output) and the dispatcher's claim / gate / back-off loop.
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BRIEF_GRACE_MS,
  BRIEF_MAX_CONSECUTIVE_FAILURES,
  BriefSkip,
  briefFailureUpdate,
  briefSinceMs,
  buildBrief,
  type BriefData,
  endOfLocalDay,
  isValidTimeZone,
  isVipSender,
  localDateOf,
  type MorningBriefDeps,
  type MorningBriefRow,
  type MorningBriefUpdate,
  nextBriefSlot,
  normalizeVipEntry,
  normalizeVipList,
  planBrief,
  runMorningBriefDispatch,
  zonedInstant,
} from "./morning-brief-engine.ts";

const H = 3_600_000;
const at = (s: string) => Date.parse(s);

// ── Time zones ───────────────────────────────────────────────────────────────

Deno.test("zonedInstant: plain days in Oslo, New York and UTC", () => {
  assertEquals(new Date(zonedInstant("2026-10-24", 7, "Europe/Oslo")).toISOString(), "2026-10-24T05:00:00.000Z");
  assertEquals(new Date(zonedInstant("2026-12-01", 7, "Europe/Oslo")).toISOString(), "2026-12-01T06:00:00.000Z");
  assertEquals(new Date(zonedInstant("2026-07-01", 7, "America/New_York")).toISOString(), "2026-07-01T11:00:00.000Z");
  assertEquals(new Date(zonedInstant("2026-07-01", 7, "UTC")).toISOString(), "2026-07-01T07:00:00.000Z");
  assertEquals(new Date(zonedInstant("2026-07-01", 0, "Asia/Kolkata")).toISOString(), "2026-06-30T18:30:00.000Z");
});

Deno.test("zonedInstant DST: spring-forward gap resolves to the first instant after it", () => {
  // Oslo 2026-03-29: 02:00 -> 03:00. 02:00 does not exist; 03:00 local is 01:00Z.
  assertEquals(new Date(zonedInstant("2026-03-29", 2, "Europe/Oslo")).toISOString(), "2026-03-29T01:00:00.000Z");
  assertEquals(new Date(zonedInstant("2026-03-29", 7, "Europe/Oslo")).toISOString(), "2026-03-29T05:00:00.000Z");
  // New York 2026-03-08: 02:00 -> 03:00.
  assertEquals(new Date(zonedInstant("2026-03-08", 2, "America/New_York")).toISOString(), "2026-03-08T07:00:00.000Z");
});

Deno.test("zonedInstant DST: fall-back repeated hour resolves to its first occurrence", () => {
  // Oslo 2026-10-25: 03:00 -> 02:00, so 02:00 happens at 00:00Z and 01:00Z.
  assertEquals(new Date(zonedInstant("2026-10-25", 2, "Europe/Oslo")).toISOString(), "2026-10-25T00:00:00.000Z");
  assertEquals(new Date(zonedInstant("2026-10-25", 7, "Europe/Oslo")).toISOString(), "2026-10-25T06:00:00.000Z");
  // New York 2026-11-01: 01:00 twice, first at 05:00Z.
  assertEquals(new Date(zonedInstant("2026-11-01", 1, "America/New_York")).toISOString(), "2026-11-01T05:00:00.000Z");
});

Deno.test("nextBriefSlot: today before the hour, inside grace, after grace, already sent", () => {
  const tz = "Europe/Oslo";
  // 06:00 local, hour 7: today 07:00.
  let slot = nextBriefSlot(at("2026-10-24T04:00:00Z"), 7, tz, null);
  assertEquals(slot.localDate, "2026-10-24");
  assertEquals(new Date(slot.slotMs).toISOString(), "2026-10-24T05:00:00.000Z");
  // 08:00 local: still today's slot (due now).
  slot = nextBriefSlot(at("2026-10-24T06:00:00Z"), 7, tz, null);
  assertEquals(slot.localDate, "2026-10-24");
  // Exactly at slot + grace: missed, tomorrow (tomorrow is the fall-back day).
  slot = nextBriefSlot(at("2026-10-24T05:00:00Z") + BRIEF_GRACE_MS, 7, tz, null);
  assertEquals(slot.localDate, "2026-10-25");
  assertEquals(new Date(slot.slotMs).toISOString(), "2026-10-25T06:00:00.000Z");
  // Already had today's.
  slot = nextBriefSlot(at("2026-10-24T06:00:00Z"), 7, tz, "2026-10-24");
  assertEquals(slot.localDate, "2026-10-25");
});

Deno.test("nextBriefSlot: a 23:00 brief served just after midnight UTC belongs to the local day", () => {
  // Los Angeles 23:00 on 2026-10-24 is 06:00Z on the 25th.
  const slot = nextBriefSlot(at("2026-10-25T06:30:00Z"), 23, "America/Los_Angeles", "2026-10-23");
  assertEquals(slot.localDate, "2026-10-24");
  assertEquals(new Date(slot.slotMs).toISOString(), "2026-10-25T06:00:00.000Z");
});

Deno.test("nextBriefSlot across DST: one brief per local day, at local 07:00", () => {
  const tz = "Europe/Oslo";
  const sent = nextBriefSlot(at("2026-03-28T06:10:00Z"), 7, tz, null);
  assertEquals(sent.localDate, "2026-03-28");
  const next = nextBriefSlot(at("2026-03-28T06:10:00Z"), 7, tz, sent.localDate);
  assertEquals(next.localDate, "2026-03-29");
  assertEquals(new Date(next.slotMs).toISOString(), "2026-03-29T05:00:00.000Z"); // 07:00 CEST
  assertEquals(next.slotMs - sent.slotMs, 23 * H);
});

Deno.test("localDateOf, endOfLocalDay and isValidTimeZone", () => {
  assertEquals(localDateOf(at("2026-10-24T22:30:00Z"), "Europe/Oslo"), "2026-10-25");
  assertEquals(new Date(endOfLocalDay("2026-10-24", "Europe/Oslo")).toISOString(), "2026-10-24T22:00:00.000Z");
  assert(isValidTimeZone("Europe/Oslo"));
  assert(isValidTimeZone("UTC"));
  assert(!isValidTimeZone("Mars/Olympus"));
  assert(!isValidTimeZone(""));
  assert(!isValidTimeZone(5));
});

// ── Settings ─────────────────────────────────────────────────────────────────

Deno.test("VIP entries: addresses and domains, normalised; junk dropped", () => {
  assertEquals(normalizeVipEntry(" Boss@Example.COM "), "boss@example.com");
  assertEquals(normalizeVipEntry("@example.com"), "example.com");
  assertEquals(normalizeVipEntry("example.com"), "example.com");
  assertEquals(normalizeVipEntry("not a domain"), null);
  assertEquals(normalizeVipEntry("a@b"), null);
  assertEquals(normalizeVipEntry(7), null);
  assertEquals(normalizeVipList(["x.com", "@X.com", "bad", "a@y.org"]), ["x.com", "a@y.org"]);
  assert(isVipSender("ceo@example.com", ["example.com"]));
  assert(isVipSender("ceo@eu.example.com", ["example.com"]));
  assert(!isVipSender("ceo@notexample.com", ["example.com"]));
  assert(isVipSender("Boss@Example.com", ["boss@example.com"]));
  assert(!isVipSender("other@example.com", ["boss@example.com"]));
  assert(!isVipSender(null, ["example.com"]));
});

Deno.test("briefSinceMs: last brief, else a day, never more than a week", () => {
  const now = at("2026-10-24T05:00:00Z");
  assertEquals(briefSinceMs({ last_sent_at: "2026-10-23T05:01:00Z" }, now), at("2026-10-23T05:01:00Z"));
  assertEquals(briefSinceMs({ last_sent_at: null }, now), now - 24 * H);
  assertEquals(briefSinceMs({ last_sent_at: "2026-09-01T00:00:00Z" }, now), now - 7 * 24 * H);
});

// ── Content (golden) ─────────────────────────────────────────────────────────

const DATA: BriefData = {
  inboxes: [
    {
      address: "me@example.org",
      count: 4,
      more: false,
      messages: [
        { fromName: "Alice Boss", fromEmail: "alice@vip.example", subject: "Board pack", date: "2026-10-24T04:30:00Z" },
        { fromName: "Shop", fromEmail: "news@shop.example", subject: "Sale‮ now", date: "2026-10-24T03:00:00Z" },
        { fromName: "", fromEmail: "bob@example.net", subject: "", date: "2026-10-23T20:00:00Z" },
        { fromName: "Carol", fromEmail: "carol@example.net", subject: "<script>x</script>", date: "2026-10-23T19:00:00Z" },
      ],
    },
    { address: "work@example.org", count: 0, more: false, messages: [] },
    { address: "old@example.org", count: 0, more: false, messages: [], error: "imap_auth_failed" },
  ],
  followUps: [{ subject: "Proposal", people: ["dan@example.com"], at: "2026-10-22T08:00:00Z", inbox: "me@example.org" }],
  snoozes: [{ subject: "Report", people: ["erin@example.com"], at: "2026-10-24T12:00:00Z", inbox: "me@example.org" }],
  scheduled: [{ subject: "Weekly update", people: ["team@example.com"], at: "2026-10-24T14:30:00Z", inbox: "work@example.org" }],
};

const OPTS = {
  locale: "en" as const,
  timezone: "Europe/Oslo",
  localDate: "2026-10-24",
  sinceMs: at("2026-10-23T05:00:00Z"),
  vips: ["vip.example"],
  appUrl: "https://mcpemails.com",
};

Deno.test("buildBrief golden: English text", () => {
  const brief = buildBrief(DATA, OPTS);
  assertEquals(brief.empty, false);
  assertEquals(brief.subject, "Morning brief, Saturday 24 October");
  assertEquals(
    brief.text,
    [
      "Your morning brief for Saturday 24 October",
      "",
      "VIP senders",
      "- Alice Boss (alice@vip.example): Board pack (in me@example.org, 06:30)",
      "",
      "New mail since Friday 07:00",
      "- me@example.org: 4 new",
      "  - Shop (news@shop.example): Sale now",
      "  - bob@example.net: (no subject)",
      "  - Carol (carol@example.net): <script>x</script>",
      "- work@example.org: No new mail.",
      "- old@example.org: could not be read. Check the connection in the dashboard.",
      "",
      "Follow-ups due",
      "- Proposal to dan@example.com, due 22 October (in me@example.org)",
      "",
      "Snoozed mail coming back today",
      "- Report from erin@example.com, at 14:00 (in me@example.org)",
      "",
      "Scheduled sends today",
      "- Weekly update to team@example.com, at 16:30 (in work@example.org)",
      "",
      "Open the dashboard: https://mcpemails.com/dashboard",
      "Change or turn off this brief: https://mcpemails.com/dashboard/settings",
      "",
      "MCPEmails put this brief in your inbox. It was not sent as an email.",
    ].join("\n"),
  );
  assertEquals(brief.counts, { newMail: 4, vip: 1, followUps: 1, snoozes: 1, scheduled: 1 });
});

Deno.test("buildBrief: HTML escapes every mailbox string and links to the dashboard", () => {
  const { html } = buildBrief(DATA, OPTS);
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert(!html.includes("‮"));
  assert(html.includes('<a href="https://mcpemails.com/dashboard">Open the dashboard</a>'));
  assert(html.startsWith("<h2>Your morning brief for Saturday 24 October</h2>"));
});

Deno.test("buildBrief: translated per locale", () => {
  const nb = buildBrief(DATA, { ...OPTS, locale: "nb" });
  assert(nb.subject.startsWith("Morgenoversikt, "), nb.subject);
  assert(nb.text.includes("VIP-avsendere"));
  const de = buildBrief(DATA, { ...OPTS, locale: "de" });
  assert(de.text.includes("Fällige Nachfassaktionen"));
  for (const locale of ["en", "nb", "fr", "es", "de"] as const) {
    const b = buildBrief(DATA, { ...OPTS, locale });
    assert(!b.text.includes("—"), `${locale}: no em dash`);
    assert(!/MCP Emails/.test(b.text), `${locale}: MCPEmails one word`);
  }
});

Deno.test("buildBrief: nothing at all is empty; a failed inbox alone is still empty", () => {
  const nothing: BriefData = { inboxes: [{ address: "a@b.co", count: 0, more: false, messages: [] }], followUps: [], snoozes: [], scheduled: [] };
  assertEquals(buildBrief(nothing, OPTS).empty, true);
  const broken: BriefData = { ...nothing, inboxes: [{ address: "a@b.co", count: 0, more: false, messages: [], error: "x" }] };
  assertEquals(buildBrief(broken, OPTS).empty, true);
  const one: BriefData = { ...nothing, scheduled: DATA.scheduled };
  assertEquals(buildBrief(one, OPTS).empty, false);
});

Deno.test("buildBrief: a full list shows N+", () => {
  const full: BriefData = { ...DATA, inboxes: [{ ...DATA.inboxes[0], count: 25, more: true }] };
  assert(buildBrief(full, OPTS).text.includes("- me@example.org: 25+ new"));
});

// ── Dispatcher ───────────────────────────────────────────────────────────────

function row(overrides: Partial<MorningBriefRow> = {}): MorningBriefRow {
  return {
    workspace_id: "ws-1",
    enabled: true,
    hour: 7,
    timezone: "Europe/Oslo",
    locale: "en",
    inbox_id: "inbox-1",
    vip_senders: ["vip.example"],
    next_due_at: null,
    last_local_date: null,
    last_sent_at: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

interface Harness {
  deps: MorningBriefDeps;
  released: { id: string; update: MorningBriefUpdate }[];
  delivered: string[];
  collected: number;
}

function harness(rows: MorningBriefRow[], opts: {
  now: number;
  allowed?: boolean;
  data?: BriefData;
  deliver?: () => Promise<void>;
  claimable?: (id: string) => boolean;
}): Harness {
  const h: Harness = { released: [], delivered: [], collected: 0, deps: undefined as unknown as MorningBriefDeps };
  const leases = new Map<string, string>();
  h.deps = {
    store: {
      releaseStaleLeases: () => Promise.resolve(0),
      listDue: () => Promise.resolve(rows),
      claim: (id, _now, token) => {
        if (opts.claimable && !opts.claimable(id)) return Promise.resolve(null);
        if (leases.has(id)) return Promise.resolve(null);
        leases.set(id, token);
        return Promise.resolve(rows.find((r) => r.workspace_id === id) ?? null);
      },
      release: (id, token, update) => {
        assertEquals(leases.get(id), token, "released with the claiming token");
        leases.delete(id);
        h.released.push({ id, update });
        return Promise.resolve();
      },
    },
    access: () => Promise.resolve({ allowed: opts.allowed ?? true }),
    collect: () => {
      h.collected++;
      return Promise.resolve(opts.data ?? DATA);
    },
    deliver: (r, brief) => {
      h.delivered.push(`${r.workspace_id}:${brief.subject}`);
      return opts.deliver ? opts.deliver() : Promise.resolve();
    },
    appUrl: "https://mcpemails.com",
    errorCode: (e) => (e instanceof Error ? e.message : "unknown"),
    newToken: () => "token-1",
    now: () => opts.now,
  };
  return h;
}

Deno.test("dispatch: a due row is claimed, built, delivered, and rescheduled for tomorrow", async () => {
  const h = harness([row()], { now: at("2026-10-24T05:02:00Z") });
  const summary = await runMorningBriefDispatch(h.deps);
  assertEquals(summary.sent, 1);
  assertEquals(h.delivered, ["ws-1:Morning brief, Saturday 24 October"]);
  const u = h.released[0].update;
  assertEquals(u.last_outcome, "sent");
  assertEquals(u.last_local_date, "2026-10-24");
  assertEquals(u.last_sent_at, "2026-10-24T05:02:00.000Z");
  assertEquals(u.next_due_at, "2026-10-25T06:00:00.000Z");
  assertEquals(u.consecutive_failures, 0);
});

Deno.test("dispatch: a row not yet due only gets its next_due_at", async () => {
  const h = harness([row()], { now: at("2026-10-24T03:00:00Z") });
  const summary = await runMorningBriefDispatch(h.deps);
  assertEquals(summary.scheduled, 1);
  assertEquals(h.collected, 0);
  assertEquals(h.released[0].update, { next_due_at: "2026-10-24T05:00:00.000Z" });
});

Deno.test("dispatch gate: a workspace not on Pro gets no brief and nothing is read", async () => {
  const h = harness([row()], { now: at("2026-10-24T05:02:00Z"), allowed: false });
  const summary = await runMorningBriefDispatch(h.deps);
  assertEquals(summary.not_allowed, 1);
  assertEquals(h.collected, 0);
  assertEquals(h.delivered.length, 0);
  assertEquals(h.released[0].update.last_outcome, "not_allowed");
  assertEquals(h.released[0].update.next_due_at, "2026-10-25T06:00:00.000Z");
});

Deno.test("dispatch: an empty brief is skipped, not delivered", async () => {
  const h = harness([row()], {
    now: at("2026-10-24T05:02:00Z"),
    data: { inboxes: [{ address: "a@b.co", count: 0, more: false, messages: [] }], followUps: [], snoozes: [], scheduled: [] },
  });
  const summary = await runMorningBriefDispatch(h.deps);
  assertEquals(summary.empty, 1);
  assertEquals(h.delivered.length, 0);
  assertEquals(h.released[0].update.last_outcome, "empty");
  assertEquals(h.released[0].update.last_sent_at, undefined);
});

Deno.test("dispatch: no target inbox and a BriefSkip close the day without back-off", async () => {
  let h = harness([row({ inbox_id: null })], { now: at("2026-10-24T05:02:00Z") });
  await runMorningBriefDispatch(h.deps);
  assertEquals(h.released[0].update.last_error_code, "target_inbox_missing");
  assertEquals(h.collected, 0);
  h = harness([row()], { now: at("2026-10-24T05:02:00Z"), deliver: () => Promise.reject(new BriefSkip("provider_unsupported")) });
  await runMorningBriefDispatch(h.deps);
  assertEquals(h.released[0].update.last_outcome, "skipped");
  assertEquals(h.released[0].update.last_error_code, "provider_unsupported");
  assertEquals(h.released[0].update.consecutive_failures, undefined);
});

Deno.test("dispatch: a delivery failure backs off, then pauses at the limit", async () => {
  const h = harness([row({ consecutive_failures: 1 })], {
    now: at("2026-10-24T05:02:00Z"),
    deliver: () => Promise.reject(new Error("provider_error")),
  });
  const summary = await runMorningBriefDispatch(h.deps);
  assertEquals(summary.failed, 1);
  const u = h.released[0].update;
  assertEquals(u.consecutive_failures, 2);
  assertEquals(u.last_error_code, "provider_error");
  assertEquals(u.next_due_at, "2026-10-24T05:17:00.000Z");
  assertEquals(u.last_local_date, undefined, "the day is not closed, so the retry still sends it");
  const paused = briefFailureUpdate({ consecutive_failures: BRIEF_MAX_CONSECUTIVE_FAILURES - 1 }, "x", 0);
  assertEquals(paused.next_due_at, null);
  assertEquals(typeof paused.paused_at, "string");
});

Deno.test("dispatch claim: a row someone else holds is skipped, never doubled", async () => {
  const h = harness([row(), row({ workspace_id: "ws-2" })], {
    now: at("2026-10-24T05:02:00Z"),
    claimable: (id) => id !== "ws-1",
  });
  const summary = await runMorningBriefDispatch(h.deps);
  assertEquals(summary.busy, 1);
  assertEquals(summary.claimed, 1);
  assertEquals(h.delivered, ["ws-2:Morning brief, Saturday 24 October"]);
});

Deno.test("planBrief: a retry after the grace window moves to tomorrow without sending", () => {
  const p = planBrief(row(), at("2026-10-24T05:00:00Z") + BRIEF_GRACE_MS + 60_000);
  assertEquals(p.kind, "wait");
  if (p.kind === "wait") assertEquals(p.update.next_due_at, "2026-10-25T06:00:00.000Z");
});
