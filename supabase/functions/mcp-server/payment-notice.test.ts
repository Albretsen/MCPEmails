// ---------------------------------------------------------------------------
// The once-a-day billing notice (payment-notice.ts).
//
// Pins the exact text, the decision, the once-per-UTC-day claim (two
// concurrent calls show it once), successful results only, and that a failing
// claim never fails the call. The last test runs the note through the real
// attachResultNote so what arrives on the wire is asserted, not just built.
//
// Run: deno test supabase/functions/mcp-server/payment-notice.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  claimPaymentNoticeDay,
  maybeAttachPaymentNotice,
  type PaymentNoticeDb,
  paymentNoticeText,
  shouldShowPaymentNotice,
  utcDay,
} from "./payment-notice.ts";
import { attachResultNote } from "./result-notes.ts";

const DECLINED =
  "MCPEmails billing notice: the last subscription payment for this account did not go through. Nothing is limited. The account owner can fix it at https://mcpemails.com/dashboard/settings (shown at most once a day).";
const CONFIRM =
  "MCPEmails billing notice: the account owner's bank is asking them to confirm the last subscription payment. Nothing is limited. They can do it at https://mcpemails.com/dashboard/settings (shown at most once a day).";

/**
 * One workspaces row, with the conditional update the claim issues applied
 * the way Postgres would: id match, issue present, day not yet claimed.
 */
function fakeDb(row: Record<string, unknown>, options: { fail?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const db: PaymentNoticeDb = {
    from(table: string) {
      assertEquals(table, "workspaces");
      let patch: Record<string, unknown> = {};
      let id: unknown = null;
      let today = "";
      const builder = {
        update(values: Record<string, unknown>) {
          patch = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          assertEquals(column, "id");
          id = value;
          return builder;
        },
        not(column: string, op: string, value: unknown) {
          assertEquals([column, op, value], ["payment_issue_since", "is", null]);
          return builder;
        },
        or(filter: string) {
          const match = /^payment_notice_shown_on\.is\.null,payment_notice_shown_on\.neq\.(\d{4}-\d{2}-\d{2})$/.exec(filter);
          assert(match, `unexpected or() filter ${filter}`);
          today = match[1];
          return builder;
        },
        async select(_columns: string) {
          calls.push({ ...patch });
          if (options.fail) return { data: null, error: { message: "connection reset" } };
          const hit = row.id === id && row.payment_issue_since != null &&
            (row.payment_notice_shown_on == null || row.payment_notice_shown_on !== today);
          if (!hit) return { data: [], error: null };
          Object.assign(row, patch);
          return { data: [{ id: row.id }], error: null };
        },
      };
      return builder;
    },
  };
  return { db, calls };
}

const NOW = Date.parse("2026-10-24T09:30:00Z");
const issueRow = () => ({
  id: "ws-1",
  payment_issue_since: "2026-10-23T10:00:00Z",
  payment_issue_kind: "declined",
  payment_notice_shown_on: null as string | null,
});

Deno.test("the exact text, for both kinds", () => {
  assertEquals(paymentNoticeText("declined"), DECLINED);
  assertEquals(paymentNoticeText("confirm"), CONFIRM);
  assertEquals(paymentNoticeText(null), DECLINED, "an unknown kind reads as a decline");
  for (const text of [DECLINED, CONFIRM]) assert(!text.includes("—"), "no em dash");
});

Deno.test("utcDay is the UTC calendar day", () => {
  assertEquals(utcDay(Date.parse("2026-10-24T23:59:59Z")), "2026-10-24");
  assertEquals(utcDay(Date.parse("2026-10-25T00:00:00Z")), "2026-10-25");
});

Deno.test("shouldShowPaymentNotice", () => {
  const todayUtc = "2026-10-24";
  assertEquals(shouldShowPaymentNotice({ paymentIssueSince: null, shownOn: null, todayUtc }), false);
  assertEquals(shouldShowPaymentNotice({ paymentIssueSince: "2026-10-20T00:00:00Z", shownOn: null, todayUtc }), true);
  assertEquals(shouldShowPaymentNotice({ paymentIssueSince: "2026-10-20T00:00:00Z", shownOn: "2026-10-23", todayUtc }), true);
  assertEquals(shouldShowPaymentNotice({ paymentIssueSince: "2026-10-20T00:00:00Z", shownOn: "2026-10-24", todayUtc }), false);
});

Deno.test("the claim succeeds once per day, so two concurrent calls show it once", async () => {
  const row = issueRow();
  const { db } = fakeDb(row);
  const [a, b] = await Promise.all([
    claimPaymentNoticeDay(db, "ws-1", "2026-10-24"),
    claimPaymentNoticeDay(db, "ws-1", "2026-10-24"),
  ]);
  assertEquals([a, b].filter(Boolean).length, 1);
  assertEquals(row.payment_notice_shown_on, "2026-10-24");
  assertEquals(await claimPaymentNoticeDay(db, "ws-1", "2026-10-25"), true, "the next day claims again");
});

Deno.test("first successful call of the day attaches the note; the second does not", async () => {
  const row = issueRow();
  const { db } = fakeDb(row);
  const notes: string[] = [];
  const logs: string[] = [];
  const run = () =>
    maybeAttachPaymentNotice({
      db,
      workspaceId: "ws-1",
      // Both calls read the row before either claimed: the claim decides.
      markers: { payment_issue_since: row.payment_issue_since, payment_issue_kind: "declined", payment_notice_shown_on: null },
      succeeded: true,
      attach: (note) => notes.push(note),
      nowMs: NOW,
      log: (event) => logs.push(event),
    });
  assertEquals(await run(), true);
  assertEquals(await run(), false);
  assertEquals(notes, [DECLINED]);
  assertEquals(logs, ["payment_notice_shown"]);
});

Deno.test("the confirm kind gets the confirm text", async () => {
  const row = { ...issueRow(), payment_issue_kind: "confirm" };
  const { db } = fakeDb(row);
  const notes: string[] = [];
  await maybeAttachPaymentNotice({
    db,
    workspaceId: "ws-1",
    markers: row,
    succeeded: true,
    attach: (note) => notes.push(note),
    nowMs: NOW,
    log: () => {},
  });
  assertEquals(notes, [CONFIRM]);
});

Deno.test("never on a failed call, never without an issue, no DB write when shown today", async () => {
  const row = issueRow();
  const { db, calls } = fakeDb(row);
  const notes: string[] = [];
  const base = { db, workspaceId: "ws-1", attach: (n: string) => notes.push(n), nowMs: NOW, log: () => {} };

  assertEquals(await maybeAttachPaymentNotice({ ...base, markers: row, succeeded: false }), false);
  assertEquals(
    await maybeAttachPaymentNotice({ ...base, markers: { ...row, payment_issue_since: null }, succeeded: true }),
    false,
  );
  assertEquals(
    await maybeAttachPaymentNotice({ ...base, markers: { ...row, payment_notice_shown_on: "2026-10-24" }, succeeded: true }),
    false,
  );
  assertEquals(await maybeAttachPaymentNotice({ ...base, markers: undefined, succeeded: true }), false);
  assertEquals(notes, []);
  assertEquals(calls.length, 0, "the hot path makes no query");
});

Deno.test("a failing claim never throws and attaches nothing", async () => {
  const { db } = fakeDb(issueRow(), { fail: true });
  const notes: string[] = [];
  const logs: string[] = [];
  const shown = await maybeAttachPaymentNotice({
    db,
    workspaceId: "ws-1",
    markers: issueRow(),
    succeeded: true,
    attach: (n) => notes.push(n),
    nowMs: NOW,
    log: (event) => logs.push(event),
  });
  assertEquals(shown, false);
  assertEquals(notes, []);
  assertEquals(logs, ["payment_notice_failed"]);
});

Deno.test("on the wire: the note reaches structuredContent and content, and skips error results", async () => {
  const payload = { messages: [] };
  const ok = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload },
  };
  const { db } = fakeDb(issueRow());
  await maybeAttachPaymentNotice({
    db,
    workspaceId: "ws-1",
    markers: issueRow(),
    succeeded: true,
    attach: (note) => attachResultNote(ok, note),
    nowMs: NOW,
    log: () => {},
  });
  assertEquals((ok.result.structuredContent as { notes?: string[] }).notes, [DECLINED]);
  assertStringIncludes(ok.result.content[0].text, "billing notice");
  assertEquals(ok.result.content.at(-1)?.text, DECLINED);

  const refused = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "cap reached" }], isError: true } };
  attachResultNote(refused, DECLINED);
  assertEquals(refused.result.content.length, 1, "attachResultNote never annotates an error");
});
