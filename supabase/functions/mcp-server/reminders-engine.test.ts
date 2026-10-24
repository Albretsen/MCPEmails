// Pro reminders: the state machine, the reply rules and the dispatcher's
// claim logic, against fakes. No network, no database.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  addressOf,
  cleanRfcMessageId,
  createSnooze,
  type LookupOutcome,
  type MoveOutcome,
  returnSnoozedMessage,
  SNOOZE_FORBIDDEN_ROLES,
  SNOOZE_RETRY_CAP_MS,
  SNOOZE_UNLOCATED,
  snoozeFolderIdForbidden,
  snoozeIdentifiable,
  decideFollowUpCheck,
  decideSnoozeAction,
  DUE_RECHECK_INTERVAL_MS,
  DUE_RECHECK_WINDOW_MS,
  failureUpdate,
  followUpDueAt,
  gmailThreadHasReply,
  graphConversationFilter,
  graphConversationHasReply,
  imapReplySearchCriteria,
  imapSinceDate,
  INBOX_BATCH_HORIZON_MS,
  isEncryptedWrapper,
  looksLikeRfcMessageId,
  MAX_REMINDERS_PER_INVOCATION,
  type MessageRef,
  nextPendingFollowUpCheck,
  NOT_ALLOWED_DEFER_MS,
  parseFollowUpDays,
  parseFutureTime,
  parseListFilter,
  parseSnoozeCondition,
  REMINDER_FAILURE_BACKOFF_MS,
  REMINDER_MAX_CONSECUTIVE_FAILURES,
  REMINDER_TIME_BUDGET_MS,
  type ReminderRow,
  type RemindersDeps,
  type ReminderUpdate,
  REPLY_CHECK_INTERVAL_MS,
  runRemindersDispatch,
  snoozeOutcomeUpdate,
  statusesForFilter,
} from "./reminders-engine.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── Arguments ──────────────────────────────────────────────────────────────

Deno.test("follow_up_days: whole days from 1 to 365 only", () => {
  assertEquals(parseFollowUpDays(3), { ok: true, value: 3 });
  for (const bad of [0, 366, 2.5, -1, "3", null, Number.NaN]) {
    assertEquals(parseFollowUpDays(bad).ok, false, String(bad));
  }
});

Deno.test("a follow-up takes exactly one of days or due_at", () => {
  assertEquals(followUpDueAt({ days: 2 }, NOW), { ok: true, value: iso(NOW + 2 * DAY) });
  assertEquals(followUpDueAt({ due_at: "2026-10-30T09:00:00+02:00" }, NOW), {
    ok: true,
    value: "2026-10-30T07:00:00.000Z",
  });
  assertEquals(followUpDueAt({}, NOW).ok, false);
  assertEquals(followUpDueAt({ days: 2, due_at: "2026-10-30T09:00:00Z" }, NOW).ok, false);
});

Deno.test("times need a zone, the future, and at most a year", () => {
  assertEquals(parseFutureTime("2026-10-30T09:00:00", NOW, "until").ok, false, "no zone");
  assertEquals(parseFutureTime("2026-10-24T11:00:00Z", NOW, "until").ok, false, "past");
  assertEquals(parseFutureTime("2027-12-01T00:00:00Z", NOW, "until").ok, false, "too far");
  assertEquals(parseFutureTime(iso(NOW + MIN), NOW, "until", 2 * MIN).ok, false, "inside the lead");
  assert(parseFutureTime("2026-11-01T08:00:00Z", NOW, "until").ok);
});

Deno.test("condition and list filter parse to their closed sets", () => {
  assertEquals(parseSnoozeCondition(undefined), { ok: true, value: "always" });
  assertEquals(parseSnoozeCondition("no_reply"), { ok: true, value: "no_reply" });
  assertEquals(parseSnoozeCondition("maybe").ok, false);
  assertEquals(parseListFilter(undefined), { ok: true, value: "due" });
  assertEquals(parseListFilter("bogus").ok, false);
  assertEquals(statusesForFilter("due"), ["due", "failed"]);
  assertEquals(statusesForFilter("upcoming"), ["pending"]);
  assertEquals(statusesForFilter("all").length, 7);
});

Deno.test("Message-IDs: brackets stripped, unsafe ids refused", () => {
  assertEquals(cleanRfcMessageId("<abc.123@mail.example>"), "abc.123@mail.example");
  assertEquals(cleanRfcMessageId('<a"b@x>'), null);
  assertEquals(cleanRfcMessageId("<a b@x>"), null);
  assertEquals(cleanRfcMessageId(null), null);
  assert(looksLikeRfcMessageId("<6f1c@mcpemails.com>"));
  assert(!looksLikeRfcMessageId("INBOX:42"));
  assert(!looksLikeRfcMessageId("18c2f0a9b1d2e3f4"));
});

Deno.test("only the encrypted wrapper shape is accepted as stored state", () => {
  assert(isEncryptedWrapper({ v: 1, data: "abc" }));
  assert(!isEncryptedWrapper({ v: 1, data: "" }));
  assert(!isEncryptedWrapper({ subject: "hi" }));
  assert(!isEncryptedWrapper(null));
});

// ── The state machine ──────────────────────────────────────────────────────

Deno.test("follow-up: a reply ends it as replied, whatever the time", () => {
  for (const status of ["pending", "due"] as const) {
    const update = decideFollowUpCheck({ status, due_at: iso(NOW + DAY) }, true, NOW);
    assertEquals(update.status, "replied");
    assertEquals(update.replied_at, iso(NOW));
    assertEquals(update.completed_at, iso(NOW));
    assertEquals(update.next_check_at, null);
    assertEquals(update.consecutive_failures, 0);
  }
});

Deno.test("follow-up: no reply before due stays pending, checked again within the interval", () => {
  const update = decideFollowUpCheck({ status: "pending", due_at: iso(NOW + DAY) }, false, NOW);
  assertEquals(update.status, "pending");
  assertEquals(update.next_check_at, iso(NOW + REPLY_CHECK_INTERVAL_MS));
});

Deno.test("follow-up: the check lands exactly on due_at when that comes first", () => {
  assertEquals(nextPendingFollowUpCheck(NOW, iso(NOW + 5 * MIN)), iso(NOW + 5 * MIN));
  // never in the past or this very minute
  assertEquals(nextPendingFollowUpCheck(NOW, iso(NOW - 5 * MIN)), iso(NOW + MIN));
});

Deno.test("follow-up: past due with no reply becomes due, re-checked slowly, then left listed", () => {
  const due = decideFollowUpCheck({ status: "pending", due_at: iso(NOW - MIN) }, false, NOW);
  assertEquals(due.status, "due");
  assertEquals(due.next_check_at, iso(NOW + DUE_RECHECK_INTERVAL_MS));
  const late = decideFollowUpCheck({ status: "due", due_at: iso(NOW - DUE_RECHECK_WINDOW_MS) }, false, NOW);
  assertEquals(late.status, "due");
  assertEquals(late.next_check_at, null);
});

Deno.test("snooze: always comes back; no_reply stays put when a reply came", () => {
  assertEquals(decideSnoozeAction("always", true), "return");
  assertEquals(decideSnoozeAction("always", false), "return");
  assertEquals(decideSnoozeAction("no_reply", false), "return");
  assertEquals(decideSnoozeAction("no_reply", true), "keep");
  assertEquals(snoozeOutcomeUpdate("return", NOW).status, "returned");
  assertEquals(snoozeOutcomeUpdate("keep", NOW).status, "replied");
});

Deno.test("failures back off, then mark the reminder failed", () => {
  let row = { consecutive_failures: 0 };
  for (let n = 1; n < REMINDER_MAX_CONSECUTIVE_FAILURES; n++) {
    const update = failureUpdate(row, "provider_error", NOW);
    assertEquals(update.status, undefined, "status is left alone until the limit");
    assertEquals(update.consecutive_failures, n);
    const backoff = REMINDER_FAILURE_BACKOFF_MS[Math.min(n, REMINDER_FAILURE_BACKOFF_MS.length) - 1];
    assertEquals(update.next_check_at, iso(NOW + backoff));
    row = { consecutive_failures: n };
  }
  const last = failureUpdate(row, "imap_auth_failed", NOW);
  assertEquals(last.status, "failed");
  assertEquals(last.next_check_at, null);
  assertEquals(last.last_error_code, "imap_auth_failed");
});

// ── Reply rules ────────────────────────────────────────────────────────────

const OWN = new Set(["me@example.com"]);

Deno.test("IMAP: one SEARCH naming the id in In-Reply-To or References, since the send, not from us", () => {
  const criteria = imapReplySearchCriteria("<abc@mcpemails.com>", NOW, ["Me@Example.com"]);
  assertEquals(
    criteria,
    `SINCE ${imapSinceDate(NOW)} OR HEADER In-Reply-To "abc@mcpemails.com" HEADER References "abc@mcpemails.com" NOT FROM "me@example.com"`,
  );
  assertEquals(imapSinceDate(NOW), "23-Oct-2026");
  assertEquals(imapReplySearchCriteria(null, NOW, []), null);
  assertEquals(imapReplySearchCriteria('<x"y@z>', NOW, []), null, "never builds an injectable string");
});

Deno.test("Gmail: a newer message from someone else in the thread is a reply; ours are not", () => {
  const since = NOW;
  const msg = (id: string, offsetMs: number, from: string, labels: string[] = ["INBOX"]) => ({
    id,
    labelIds: labels,
    internalDate: String(since + offsetMs),
    payload: { headers: [{ name: "From", value: from }] },
  });
  const tracked = msg("m1", 0, "Me <me@example.com>", ["SENT"]);
  assertEquals(gmailThreadHasReply([tracked], "m1", since, OWN), false);
  assertEquals(gmailThreadHasReply([tracked, msg("m2", MIN, "Me <me@example.com>")], "m1", since, OWN), false);
  assertEquals(gmailThreadHasReply([tracked, msg("m3", MIN, "x <x@y.example>", ["SENT"])], "m1", since, OWN), false);
  assertEquals(gmailThreadHasReply([tracked, msg("m4", -MIN, "Bob <bob@y.example>")], "m1", since, OWN), false, "older");
  assertEquals(gmailThreadHasReply([tracked, msg("m5", MIN, "Bob <bob@y.example>")], "m1", since, OWN), true);
});

Deno.test("Graph: the same rule over a conversation, drafts excluded", () => {
  const since = NOW;
  const m = (id: string, offsetMs: number, address: string, isDraft = false) => ({
    id,
    isDraft,
    receivedDateTime: iso(since + offsetMs),
    from: { emailAddress: { address } },
  });
  assertEquals(graphConversationHasReply([m("a", MIN, "me@example.com")], "t", since, OWN), false);
  assertEquals(graphConversationHasReply([m("a", MIN, "bob@y.example", true)], "t", since, OWN), false);
  assertEquals(graphConversationHasReply([m("t", MIN, "bob@y.example")], "t", since, OWN), false, "the tracked one");
  assertEquals(graphConversationHasReply([m("a", MIN, "Bob@Y.example")], "t", since, OWN), true);
  assertEquals(
    graphConversationFilter("AAQk'x", "2026-10-24T12:00:00.000Z"),
    "conversationId eq 'AAQk''x' and receivedDateTime gt 2026-10-24T12:00:00.000Z",
  );
});

Deno.test("addressOf reads display-name and bare forms", () => {
  assertEquals(addressOf("Bob <Bob@Y.example>"), "bob@y.example");
  assertEquals(addressOf("bob@y.example"), "bob@y.example");
  assertEquals(addressOf("not an address"), null);
});

// ── The dispatcher ─────────────────────────────────────────────────────────

interface FakeRow extends ReminderRow {
  last_error_code?: string | null;
  claimed_at: string | null;
  lease_token: string | null;
}

function row(partial: Partial<FakeRow>): FakeRow {
  return {
    id: crypto.randomUUID(),
    workspace_id: "ws-1",
    inbox_id: "inbox-1",
    api_key_id: "key-1",
    kind: "follow_up",
    status: "pending",
    condition: "no_reply",
    due_at: iso(NOW + DAY),
    next_check_at: iso(NOW - MIN),
    message_ref: { v: 1, data: "x" },
    consecutive_failures: 0,
    claimed_at: null,
    lease_token: null,
    ...partial,
  };
}

/** An in-memory store with the same predicates as remindersStore in index.ts. */
function fakeWorld(rows: FakeRow[], opts: {
  replied?: Set<string>;
  allowed?: boolean;
  openFails?: boolean;
  checkFails?: boolean;
  foreignLease?: string;
  clockStep?: number;
} = {}) {
  let clock = NOW;
  const sessions: string[] = [];
  const closed: string[] = [];
  const checks: string[] = [];
  const returns: string[] = [];
  const updates: Array<{ id: string; update: ReminderUpdate }> = [];
  const open = (r: FakeRow) => r.status === "pending" || r.status === "due";
  const deps: RemindersDeps = {
    now: () => (clock += opts.clockStep ?? 0),
    newToken: () => "token-me",
    store: {
      releaseStaleLeases: () => Promise.resolve(0),
      listDue: (nowIso, limit) =>
        Promise.resolve(
          rows.filter((r) => open(r) && !r.claimed_at && r.next_check_at && r.next_check_at <= nowIso)
            .sort((a, b) => a.next_check_at!.localeCompare(b.next_check_at!))
            .slice(0, limit),
        ),
      inboxLeaseHeld: (inboxId, token) =>
        Promise.resolve(
          rows.some((r) => r.inbox_id === inboxId && r.claimed_at && r.lease_token !== token) ||
            opts.foreignLease === inboxId,
        ),
      claimInbox: (inboxId, nowIso, horizonIso, token, limit) => {
        const picked = rows.filter((r) =>
          r.inbox_id === inboxId && open(r) && !r.claimed_at && r.next_check_at &&
          (r.next_check_at <= nowIso || (r.kind === "follow_up" && r.next_check_at <= horizonIso))
        ).slice(0, limit);
        for (const r of picked) {
          r.claimed_at = nowIso;
          r.lease_token = token;
        }
        return Promise.resolve(picked.map((r) => ({ ...r })));
      },
      release: (id, token, update) => {
        const r = rows.find((x) => x.id === id)!;
        if (r.lease_token !== token) return Promise.resolve();
        Object.assign(r, update, { claimed_at: null, lease_token: null });
        updates.push({ id, update });
        return Promise.resolve();
      },
    },
    access: () => Promise.resolve({ allowed: opts.allowed ?? true }),
    decryptRef: () =>
      Promise.resolve({ provider_message_id: "m", thread_id: null, rfc_message_id: "a@b", since: iso(NOW) } as MessageRef),
    encryptRef: () => Promise.resolve({ v: 1, data: "y" }),
    openSession: (inboxId) => {
      if (opts.openFails) return Promise.reject(new Error("imap_auth_failed"));
      sessions.push(inboxId);
      return Promise.resolve({ inboxId });
    },
    closeSession: (s) => {
      closed.push((s as { inboxId: string }).inboxId);
      return Promise.resolve();
    },
    checkReply: (s) => {
      if (opts.checkFails) return Promise.reject(new Error("provider_error"));
      const inboxId = (s as { inboxId: string }).inboxId;
      checks.push(inboxId);
      return Promise.resolve(opts.replied?.has(inboxId) ?? false);
    },
    returnSnoozed: (_s, ref) => {
      returns.push(ref.provider_message_id);
      return Promise.resolve({ ref });
    },
    errorCode: (e) => (e instanceof Error ? e.message : "unknown"),
  };
  return { deps, sessions, closed, checks, returns, updates, rows };
}

Deno.test("dispatcher: one session per inbox, every due row of it checked on that session", async () => {
  const rows = [
    row({ inbox_id: "a" }),
    row({ inbox_id: "a" }),
    row({ inbox_id: "b" }),
    // pulled forward: due within the batch horizon on an inbox being opened anyway
    row({ inbox_id: "a", next_check_at: iso(NOW + INBOX_BATCH_HORIZON_MS - MIN) }),
    // not pulled forward: beyond the horizon
    row({ inbox_id: "a", next_check_at: iso(NOW + INBOX_BATCH_HORIZON_MS + MIN) }),
  ];
  const world = fakeWorld(rows, { replied: new Set(["b"]) });
  const summary = await runRemindersDispatch(world.deps);
  assertEquals(world.sessions, ["a", "b"]);
  assertEquals(world.closed, ["a", "b"]);
  assertEquals(world.checks, ["a", "a", "a", "b"]);
  assertEquals(summary.claimed, 4);
  assertEquals(summary.replied, 1);
  assertEquals(rows[2].status, "replied");
  assertEquals(rows[0].status, "pending");
  assert(rows.every((r) => r.claimed_at === null), "every lease is released");
});

Deno.test("dispatcher: an inbox another run holds is skipped, not doubled", async () => {
  const rows = [row({ inbox_id: "a" }), row({ inbox_id: "b" })];
  const world = fakeWorld(rows, { foreignLease: "a" });
  const summary = await runRemindersDispatch(world.deps);
  assertEquals(world.sessions, ["b"]);
  assertEquals(summary.inbox_busy, 1);
  assertEquals(rows[0].next_check_at, iso(NOW - MIN), "untouched, still due next minute");
});

Deno.test("dispatcher: a follow-up of a workspace off Pro is deferred without a provider call; a snooze still returns", async () => {
  const rows = [
    row({ inbox_id: "a" }),
    row({ inbox_id: "a", kind: "snooze", condition: "always", due_at: iso(NOW - MIN) }),
  ];
  const world = fakeWorld(rows, { allowed: false });
  const summary = await runRemindersDispatch(world.deps);
  assertEquals(world.checks, []);
  assertEquals(world.returns.length, 1, "mail is never left hidden");
  assertEquals(rows[0].next_check_at, iso(NOW + NOT_ALLOWED_DEFER_MS));
  assertEquals(rows[0].status, "pending");
  assertEquals(rows[1].status, "returned");
  assertEquals(summary.deferred, 1);
});

Deno.test("dispatcher: a follow-up whose key was revoked is cancelled; a snooze without a key still returns", async () => {
  const rows = [
    row({ inbox_id: "a", api_key_id: null }),
    row({ inbox_id: "a", api_key_id: null, kind: "snooze", condition: "always", due_at: iso(NOW - MIN) }),
  ];
  const world = fakeWorld(rows);
  await runRemindersDispatch(world.deps);
  assertEquals(rows[0].status, "cancelled");
  assertEquals(rows[1].status, "returned");
});

Deno.test("dispatcher: a no_reply snooze with a reply stays where it is", async () => {
  const rows = [row({ inbox_id: "a", kind: "snooze", condition: "no_reply", due_at: iso(NOW - MIN) })];
  const world = fakeWorld(rows, { replied: new Set(["a"]) });
  await runRemindersDispatch(world.deps);
  assertEquals(world.returns, []);
  assertEquals(rows[0].status, "replied");
});

Deno.test("dispatcher: a session that will not open backs every row off", async () => {
  const rows = [row({ inbox_id: "a" }), row({ inbox_id: "a", consecutive_failures: 4 })];
  const world = fakeWorld(rows, { openFails: true });
  const summary = await runRemindersDispatch(world.deps);
  assertEquals(rows[0].consecutive_failures, 1);
  assertEquals(rows[0].last_error_code, "imap_auth_failed");
  assertEquals(rows[1].status, "failed");
  assertEquals(summary.failed, 1);
});

Deno.test("dispatcher: a failed check backs that row off and closes the session", async () => {
  const rows = [row({ inbox_id: "a" })];
  const world = fakeWorld(rows, { checkFails: true });
  await runRemindersDispatch(world.deps);
  assertEquals(rows[0].consecutive_failures, 1);
  assertEquals(world.closed, ["a"]);
});

Deno.test("dispatcher: the wall-clock budget hands unprocessed rows back untouched", async () => {
  const rows = Array.from({ length: 5 }, () => row({ inbox_id: "a" }));
  const world = fakeWorld(rows, { clockStep: REMINDER_TIME_BUDGET_MS / 8 });
  const summary = await runRemindersDispatch(world.deps);
  assert(summary.budget_exhausted);
  assert(world.checks.length < 5);
  assert(rows.every((r) => r.claimed_at === null), "every lease is released");
  assert(rows.some((r) => r.next_check_at === iso(NOW - MIN)), "some rows still due");
});

Deno.test("dispatcher: one invocation claims a bounded batch", async () => {
  const rows = Array.from({ length: MAX_REMINDERS_PER_INVOCATION + 20 }, (_, i) => row({ inbox_id: `i${i}` }));
  const world = fakeWorld(rows);
  const summary = await runRemindersDispatch(world.deps);
  assert(summary.claimed <= MAX_REMINDERS_PER_INVOCATION);
});

// ── Review findings (PR #268) ──────────────────────────────────────────────

Deno.test("a snooze never goes terminal on a retryable error: 4 h, then daily, for ever", () => {
  let failures = 0;
  const seen: number[] = [];
  for (let i = 0; i < 12; i++) {
    const update = failureUpdate({ consecutive_failures: failures, kind: "snooze" }, "imap_auth_failed", NOW);
    assertEquals(update.status, undefined, `failure ${i + 1} must not end the snooze`);
    seen.push(Date.parse(update.next_check_at!) - NOW);
    failures = update.consecutive_failures!;
  }
  assertEquals(seen.slice(0, 4), [...REMINDER_FAILURE_BACKOFF_MS]);
  assert(seen.slice(4).every((ms) => ms === SNOOZE_RETRY_CAP_MS), "daily after the ladder");
  // An unreadable reference cannot be retried into working.
  assertEquals(failureUpdate({ consecutive_failures: 0, kind: "snooze" }, "reference_unreadable", NOW).status, "failed");
  // Follow-ups still stop at the limit.
  assertEquals(
    failureUpdate({ consecutive_failures: REMINDER_MAX_CONSECUTIVE_FAILURES - 1, kind: "follow_up" }, "provider_error", NOW)
      .status,
    "failed",
  );
});

Deno.test("dispatcher: a long-failing snooze is retried, never failed", async () => {
  const rows = [row({ inbox_id: "a", kind: "snooze", condition: "always", due_at: iso(NOW - DAY), consecutive_failures: 9 })];
  const world = fakeWorld(rows, { openFails: true });
  await runRemindersDispatch(world.deps);
  assertEquals(rows[0].status, "pending");
  assertEquals(rows[0].next_check_at, iso(NOW + SNOOZE_RETRY_CAP_MS));
});

Deno.test("reconnecting an inbox re-arms its backed-off reminders (migration trigger)", async () => {
  const sql = await Deno.readTextFile(new URL("../../migrations/20261024235200_reminders.sql", import.meta.url));
  assert(/CREATE TRIGGER reminders_rearm_on_reconnect\s+AFTER UPDATE OF status, imap_password, oauth_refresh_token ON public\.inboxes/.test(sql));
  assert(/NEW\.status = 'active'/.test(sql));
  const body = sql.slice(sql.indexOf("FUNCTION public.reminders_rearm_on_reconnect()"));
  for (const clause of ["consecutive_failures > 0", "claimed_at IS NULL", "kind = 'follow_up' OR due_at <= now()"]) {
    assert(body.includes(clause), clause);
  }
  const selfHost = await Deno.readTextFile(new URL("../../../self-host/db/00-schema.sql", import.meta.url));
  assert(selfHost.includes("CREATE TRIGGER reminders_rearm_on_reconnect"));
});

const SNOOZED: MessageRef = {
  provider_message_id: "INBOX:7",
  thread_id: null,
  rfc_message_id: "abc@x.example",
  since: iso(NOW),
  snoozed_message_id: "MCPEmails Snoozed:3",
  snooze_folder_id: "MCPEmails Snoozed",
};

function returnSeams(opts: { moves: Array<MoveOutcome>; lookup?: LookupOutcome }) {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      move: (id: string) => {
        calls.push(`move ${id}`);
        return Promise.resolve(opts.moves.shift() ?? { moved: false as const, error: "move_failed" });
      },
      find: (folder: string) => {
        calls.push(`find ${folder}`);
        return Promise.resolve(opts.lookup ?? { searched: true, id: null });
      },
      code: (e: string) => `code:${e}`,
    },
  };
}

Deno.test("return: the stored id moves back without a search", async () => {
  const { seams, calls } = returnSeams({ moves: [{ moved: true, newId: "INBOX:9" }] });
  const out = await returnSnoozedMessage(SNOOZED, seams);
  assertEquals(out, { ref: { ...SNOOZED, snoozed_message_id: "INBOX:9" } });
  assertEquals(calls, ["move MCPEmails Snoozed:3"]);
});

Deno.test("return: not found ONLY when a search of the snooze folder ran and was empty", async () => {
  const empty = returnSeams({ moves: [{ moved: false, error: "message_not_found" }], lookup: { searched: true, id: null } });
  assertEquals((await returnSnoozedMessage(SNOOZED, empty.seams)).notFound, true);
  assertEquals(empty.calls, ["move MCPEmails Snoozed:3", "find MCPEmails Snoozed"]);

  const found = returnSeams({
    moves: [{ moved: false, error: "message_not_found" }, { moved: true, newId: null }],
    lookup: { searched: true, id: "MCPEmails Snoozed:40" },
  });
  const moved = await returnSnoozedMessage(SNOOZED, found.seams);
  assertEquals(moved.notFound, undefined);
  assertEquals(moved.ref.snoozed_message_id, "MCPEmails Snoozed:40");
});

Deno.test("return: no search possible is a retryable failure, never not-found", async () => {
  const noSearch = returnSeams({ moves: [{ moved: false, error: "x" }], lookup: { searched: false, id: null } });
  await assertRejects(() => returnSnoozedMessage(SNOOZED, noSearch.seams), Error, SNOOZE_UNLOCATED);
  const noFolder = returnSeams({ moves: [] });
  await assertRejects(
    () => returnSnoozedMessage({ ...SNOOZED, snoozed_message_id: null, snooze_folder_id: null }, noFolder.seams),
    Error,
    SNOOZE_UNLOCATED,
  );
  // never knew the moved id: goes straight to the search
  const unknownId = returnSeams({ moves: [{ moved: true, newId: "INBOX:1" }], lookup: { searched: true, id: "S:2" } });
  await returnSnoozedMessage({ ...SNOOZED, snoozed_message_id: null }, unknownId.seams);
  assertEquals(unknownId.calls, ["find MCPEmails Snoozed", "move S:2"]);
  // a found message that will not move is a coded, retryable error
  const stuck = returnSeams({ moves: [{ moved: false, error: "a" }, { moved: false, error: "b" }], lookup: { searched: true, id: "S:2" } });
  await assertRejects(() => returnSnoozedMessage(SNOOZED, stuck.seams), Error, "code:b");
});

Deno.test("an IMAP snooze needs COPYUID or a searchable Message-ID", () => {
  assert(snoozeIdentifiable({ imapLike: false, rfcMessageId: null, uidplus: false }));
  assert(snoozeIdentifiable({ imapLike: true, rfcMessageId: "<a@b.example>", uidplus: false }));
  assert(snoozeIdentifiable({ imapLike: true, rfcMessageId: null, uidplus: true }));
  assert(!snoozeIdentifiable({ imapLike: true, rfcMessageId: null, uidplus: false }));
  assert(!snoozeIdentifiable({ imapLike: true, rfcMessageId: '<a"b@c>', uidplus: false }), "an unsearchable id does not count");
});

function createSeams(opts: {
  insert?: "ok" | "duplicate" | "error";
  move?: MoveOutcome | Error;
  save?: boolean;
  undo?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    seams: {
      insertLeased: () => {
        calls.push("insert");
        return Promise.resolve(opts.insert ?? "ok");
      },
      deleteRow: () => {
        calls.push("delete");
        return Promise.resolve();
      },
      move: () => {
        calls.push("move");
        return opts.move instanceof Error ? Promise.reject(opts.move) : Promise.resolve(opts.move ?? { moved: true as const, newId: "S:1" });
      },
      save: () => {
        calls.push("save");
        return Promise.resolve(opts.save ?? true);
      },
      undoMove: () => {
        calls.push("undo");
        return Promise.resolve(opts.undo ?? true);
      },
    },
  };
}

const PENDING: MessageRef = { ...SNOOZED, snoozed_message_id: null };

Deno.test("create: the row is written (leased) before the move, saved after", async () => {
  const { seams, calls } = createSeams({});
  const out = await createSnooze(PENDING, true, seams);
  assertEquals(out, { kind: "snoozed", ref: { ...PENDING, snoozed_message_id: "S:1" } });
  assertEquals(calls, ["insert", "move", "save"]);
});

Deno.test("create: a failed move deletes the row; a thrown move too", async () => {
  for (const move of [{ moved: false as const, error: "nope" }, new Error("boom")]) {
    const { seams, calls } = createSeams({ move });
    const out = await createSnooze(PENDING, true, seams);
    assertEquals(out.kind, "move_failed");
    assertEquals(calls, ["insert", "move", "delete"]);
  }
});

Deno.test("create: a duplicate insert (23505) is the existing snooze, nothing moved or undone", async () => {
  const { seams, calls } = createSeams({ insert: "duplicate" });
  assertEquals((await createSnooze(PENDING, true, seams)).kind, "already_snoozed");
  assertEquals(calls, ["insert"]);
  const failed = createSeams({ insert: "error" });
  assertEquals((await createSnooze(PENDING, true, failed.seams)).kind, "insert_failed");
  assertEquals(failed.calls, ["insert"]);
});

Deno.test("create: a failed save keeps a locatable snooze, else undoes and says whether it worked", async () => {
  const locatable = createSeams({ save: false });
  assertEquals((await createSnooze(PENDING, true, locatable.seams)).kind, "saved_partially");
  assertEquals(locatable.calls, ["insert", "move", "save"]);

  const undone = createSeams({ save: false, undo: true });
  assertEquals(await createSnooze(PENDING, false, undone.seams), { kind: "save_failed", restored: true });
  assertEquals(undone.calls, ["insert", "move", "save", "undo", "delete"]);

  const stuck = createSeams({ save: false, undo: false });
  assertEquals(await createSnooze(PENDING, false, stuck.seams), { kind: "save_failed", restored: false });
  assertEquals(stuck.calls, ["insert", "move", "save", "undo"], "the row stays: it still knows where the mail is");
});

Deno.test("snooze folders: inbox, Trash, Spam/Junk, Drafts and Sent are refused by id", () => {
  for (const id of ["INBOX", "TRASH", "SPAM", "DRAFT", "SENT"]) assert(snoozeFolderIdForbidden("gmail", id), id);
  assert(!snoozeFolderIdForbidden("gmail", "Label_12"));
  for (const id of ["inbox", "deleteditems", "JunkEmail", "drafts", "sentitems"]) assert(snoozeFolderIdForbidden("outlook", id), id);
  assert(!snoozeFolderIdForbidden("outlook", "AAMkAGI2..."));
  assert(snoozeFolderIdForbidden("imap", "INBOX"));
  assert(!snoozeFolderIdForbidden("imap", "MCPEmails Snoozed"));
  assertEquals([...SNOOZE_FORBIDDEN_ROLES], ["inbox", "trash", "spam", "drafts", "sent"]);
});

Deno.test("a follow-up on an existing message counts days from its own sent date", () => {
  const sent = NOW - 5 * DAY;
  assertEquals(followUpDueAt({ days: 3 }, NOW, sent), { ok: true, value: iso(sent + 3 * DAY) });
  assertEquals(followUpDueAt({ days: 3 }, NOW), { ok: true, value: iso(NOW + 3 * DAY) });
  // an explicit due_at is still checked against now
  assertEquals(followUpDueAt({ due_at: iso(NOW - DAY) }, NOW, sent).ok, false);
});
