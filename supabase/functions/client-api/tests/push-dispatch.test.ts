// The new-mail watcher (push/dispatch.ts, push/notify.ts): what counts as new
// mail, what a notification says, leasing, the time budget, backoff, burst
// collapse, dead subscriptions, and that nothing read from a mailbox reaches
// the log or the store. In-memory fakes throughout; no network.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ApiError } from "../errors.ts";
import { loginRefusedMarker } from "../mail/health.ts";
import {
  BACKOFF,
  backoffMs,
  BATCH_SIZE,
  type DispatchDeps,
  HOST_CONCURRENCY,
  intervalFor,
  MAX_CONCURRENCY,
  NEW_MAIL_TTL_SEC,
  pickNew,
  PROVIDER_CONCURRENCY,
  runDispatch,
  TICK_SLACK_MS,
} from "../push/dispatch.ts";
import {
  buildNewMailPayload,
  detectArrival,
  inQuietHours,
  type NewMailPayload,
  senderName,
  topicFor,
} from "../push/notify.ts";
import { MAX_PLAINTEXT_BYTES } from "../push/webpush.ts";
import { browserKeys, fakeMail, fakePushStore, fakeSender, imapCursor } from "./push-fakes.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inboxId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const INBOX = inboxId(1);

// Mail content used by the fakes. None of it may ever reach a log line or the store.
const SECRET_FROM = "Maya Berg <maya.berg@north-secret.example>";
const SECRET_SUBJECT = "Kvartalsrapport: konfidensielt utkast";
const SECRET_LABEL = "owner-private@mailbox-secret.example";
const SECRETS = ["Maya", "north-secret", "Kvartalsrapport", "konfidensielt", "mailbox-secret", "owner-private"];

async function rig(options: { start?: number } = {}) {
  let clock = options.start ?? Date.UTC(2026, 9, 5, 12, 0, 0);
  const now = () => clock;
  const store = fakePushStore(now, WS);
  const mail = fakeMail((id) => store.watches.find((w) => w.inbox_id === id)?.mail_host ?? "host");
  const sender = fakeSender();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps: DispatchDeps = { store, mail, sender, now, log: (event, fields) => logs.push({ event, fields }) };
  const subscribe = async (userId = USER, endpoint = "https://fcm.googleapis.com/fcm/send/device-1") => {
    await store.upsertSubscription({ userId, workspaceId: WS, endpoint, ...(await browserKeys()), userAgent: null });
    return store.subs.find((s) => s.endpoint === endpoint)!;
  };
  return {
    store,
    mail,
    sender,
    logs,
    deps,
    subscribe,
    advance: (ms: number) => {
      clock += ms;
    },
    now,
  };
}

/** One pass, then the clock moves to the mailbox's next check. */
async function pass(r: Awaited<ReturnType<typeof rig>>, ms = 120_000) {
  const summary = await runDispatch(r.deps);
  r.advance(ms);
  return summary;
}

// ── what counts as new mail ─────────────────────────────────────────────────

Deno.test("detectArrival (IMAP): UIDNEXT growth with a growing count is new mail; a flag change is not", () => {
  const before = imapCursor(100, 40, 3);
  assertEquals(detectArrival("imap", null, before), { kind: "first" });
  assertEquals(detectArrival("imap", before, before), { kind: "unchanged" });
  assertEquals(detectArrival("imap", before, imapCursor(102, 42, 5)), { kind: "new", count: 2 });
  // A message was read: UNSEEN moved, UIDNEXT did not.
  assertEquals(detectArrival("imap", before, imapCursor(100, 40, 2)), { kind: "changed" });
  // A message was deleted.
  assertEquals(detectArrival("imap", before, imapCursor(100, 39, 3)), { kind: "changed" });
  // A star on a CONDSTORE server: only HIGHESTMODSEQ moves.
  assertEquals(
    detectArrival("imap", { ...before, fingerprint: "i:1700000000:100:40:3:900:-" }, { ...before, fingerprint: "i:1700000000:100:40:3:901:-" }),
    { kind: "changed" },
  );
  // Arrived and already read and filed elsewhere: nothing to announce.
  assertEquals(detectArrival("imap", before, imapCursor(101, 40, 3)), { kind: "changed" });
  // One arrived while another was deleted: the unread count still grew.
  assertEquals(detectArrival("imap", before, imapCursor(101, 40, 4)), { kind: "new", count: 1 });
  // UIDVALIDITY changed: the numbers are not comparable.
  assertEquals(detectArrival("imap", before, imapCursor(5, 41, 4, 1800000000)), { kind: "reset" });
  assertEquals(detectArrival("fastmail", before, imapCursor(101, 41, 4)), { kind: "new", count: 1 });
});

Deno.test("detectArrival (Outlook): both counters must grow", () => {
  const before = { fingerprint: "o:40:3:a@1", total: 40, unread: 3 };
  assertEquals(detectArrival("outlook", before, { fingerprint: "o:41:4:b@2", total: 41, unread: 4 }), { kind: "new", count: 1 });
  assertEquals(detectArrival("outlook", before, { fingerprint: "o:40:2:a@3", total: 40, unread: 2 }), { kind: "changed" });
  assertEquals(detectArrival("outlook", before, { fingerprint: "o:41:3:c@4", total: 41, unread: 3 }), { kind: "changed" }, "a read message moved in");
  assertEquals(detectArrival("outlook", before, { fingerprint: "o:40:3:a@9", total: 40, unread: 3 }), { kind: "changed" }, "a flag");
});

Deno.test("detectArrival (Gmail): a moved historyId asks history, from the OLD id", () => {
  const before = { fingerprint: "g:9001", total: 40, unread: 3 };
  assertEquals(detectArrival("gmail", before, { fingerprint: "g:9050", total: 41, unread: 4 }), { kind: "ask_history", startHistoryId: "9001" });
  assertEquals(detectArrival("gmail", before, before), { kind: "unchanged" });
  assertEquals(detectArrival("gmail", { ...before, fingerprint: "i:1:2:3:4:-:-" }, { fingerprint: "g:9050", total: 1, unread: 1 }), { kind: "reset" });
});

Deno.test("quiet hours: a window, a window across midnight, and an unknown zone", () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 5, h, m); // October: Oslo is UTC+2
  const night = { quiet_start: 22 * 60, quiet_end: 7 * 60, quiet_timezone: "Europe/Oslo" };
  assert(inQuietHours(night, at(21)), "23:00 in Oslo");
  assert(inQuietHours(night, at(3)), "05:00 in Oslo");
  assert(!inQuietHours(night, at(6)), "08:00 in Oslo");
  assert(!inQuietHours(night, at(19, 59)), "21:59 in Oslo");
  const lunch = { quiet_start: 12 * 60, quiet_end: 13 * 60, quiet_timezone: "UTC" };
  assert(inQuietHours(lunch, at(12, 30)));
  assert(!inQuietHours(lunch, at(13)));
  assert(!inQuietHours({ quiet_start: null, quiet_end: null, quiet_timezone: null }, at(3)));
  assert(!inQuietHours({ quiet_start: 0, quiet_end: 0, quiet_timezone: "UTC" }, at(3)), "an empty window");
  assert(!inQuietHours({ ...night, quiet_timezone: "Not/AZone" }, at(21)), "an unknown zone never silences");
});

// ── what a notification says ────────────────────────────────────────────────

Deno.test("payload (rich, one message): sender name as title, subject as body, a deep link to the message", () => {
  const payload = buildNewMailPayload({
    mode: "rich",
    inboxId: INBOX,
    mailboxLabel: "Work",
    count: 1,
    unread: 4,
    messages: [{ id: "INBOX:4182", from: SECRET_FROM, subject: SECRET_SUBJECT }],
  });
  assertEquals(payload, {
    type: "new_mail",
    mode: "rich",
    title: "Maya Berg",
    body: SECRET_SUBJECT,
    url: `/${INBOX}/inbox/${encodeURIComponent(`${INBOX}:INBOX:4182`)}`,
    tag: `mail-${INBOX}`,
    inbox_id: INBOX,
    count: 1,
    unread: 4,
  });
  assert(!JSON.stringify(payload).includes("north-secret"), "the sender's address is not in the payload when there is a name");
});

Deno.test("payload (rich, several): at most three lines and a remainder, linking to the mailbox", () => {
  const messages = [1, 2, 3, 4, 5].map((n) => ({ id: `m${n}`, from: `Sender ${n} <s${n}@x.example>`, subject: `Subject ${n}` }));
  const payload = buildNewMailPayload({ mode: "rich", inboxId: INBOX, mailboxLabel: "Work", count: 5, unread: 9, messages });
  assertEquals(payload.title, "5 new messages in Work");
  assertEquals(payload.body, "Sender 1: Subject 1\nSender 2: Subject 2\nSender 3: Subject 3\nand 2 more");
  assertEquals(payload.url, `/${INBOX}/inbox`);
});

Deno.test("payload (private): a count and the mailbox name, and nothing else, even when messages are supplied", () => {
  const payload = buildNewMailPayload({
    mode: "private",
    inboxId: INBOX,
    mailboxLabel: "Work",
    count: 2,
    unread: 4,
    messages: [{ id: "m1", from: SECRET_FROM, subject: SECRET_SUBJECT }],
  });
  assertEquals(payload, {
    type: "new_mail",
    mode: "private",
    title: "New mail",
    body: "2 new messages in Work",
    url: `/${INBOX}/inbox`,
    tag: `mail-${INBOX}`,
    inbox_id: INBOX,
    count: 2,
    unread: 4,
  });
  assertEquals(buildNewMailPayload({ mode: "private", inboxId: INBOX, mailboxLabel: "Work", count: 1, unread: 1, messages: [] }).body, "1 new message in Work");
});

Deno.test("payload: long and hostile text is cut and flattened, and always fits one push message", () => {
  const payload = buildNewMailPayload({
    mode: "rich",
    inboxId: INBOX,
    mailboxLabel: "L".repeat(500),
    count: 3,
    unread: 3,
    messages: [1, 2, 3].map((n) => ({ id: `id-${"x".repeat(300)}-${n}`, from: `${"N".repeat(400)} <a@b.example>`, subject: `line one\r\nline two\u0000${"S".repeat(2000)}` })),
  });
  for (const line of payload.body.split("\n")) assert(Array.from(line).length <= 60 + 2 + 110, "each line is bounded");
  assert(!payload.body.includes("\r") && !payload.body.includes("\u0000"));
  assertStringIncludes(payload.body, "line one line two");
  assert(new TextEncoder().encode(JSON.stringify(payload)).length < MAX_PLAINTEXT_BYTES);
  // Multi-byte text: still inside the limit.
  const wide = buildNewMailPayload({
    mode: "rich",
    inboxId: INBOX,
    mailboxLabel: "郵".repeat(500),
    count: 3,
    unread: 3,
    messages: [1, 2, 3].map((n) => ({ id: `m${n}`, from: "名".repeat(400), subject: "件".repeat(2000) })),
  });
  assert(new TextEncoder().encode(JSON.stringify(wide)).length < MAX_PLAINTEXT_BYTES);
});

Deno.test("senderName, topicFor, pickNew", () => {
  assertEquals(senderName('"Berg, Maya" <maya@x.example>'), "Berg, Maya");
  assertEquals(senderName("<maya@x.example>"), "maya@x.example");
  assertEquals(senderName("maya@x.example"), "maya@x.example");
  assertEquals(senderName(""), "Unknown sender");
  assertEquals(topicFor(INBOX), "2222222222224222822200000000" + "0001");
  assertEquals(topicFor(INBOX).length, 32);
  const rows = [
    { id: "a", from: "A", subject: "1", unread: true },
    { id: "b", from: "B", subject: "2", unread: false },
    { id: "c", from: "C", subject: "3", unread: true },
  ];
  assertEquals(pickNew(rows, 1, null).map((m) => m.id), ["a"], "newest unread, as many as arrived");
  assertEquals(pickNew(rows, 2, null).map((m) => m.id), ["a", "c"]);
  assertEquals(pickNew(rows, 5, ["c", "zzz"]).map((m) => m.id), ["c"], "by id when the provider named them");
});

// ── a pass ──────────────────────────────────────────────────────────────────

Deno.test("first observation records the cursor and notifies nobody, however much mail is there", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: imapCursor(5000, 4200, 371) });
  const summary = await runDispatch(r.deps);
  assertEquals([summary.leased, summary.checked, summary.arrivals, summary.pushes_sent], [1, 1, 0, 0]);
  assertEquals(r.sender.sent.length, 0);
  assertEquals(r.mail.calls.map((c) => c.op), ["probe"], "no list, no history");
  const row = r.store.watches[0];
  assertEquals(row.folders, { inbox: imapCursor(5000, 4200, 371) });
  assertEquals(row.lease_id, null, "the lease is given back");
  assertEquals(Date.parse(row.next_check_at), r.now() + intervalFor("imap") - TICK_SLACK_MS);
  assertEquals(r.mail.closed, 1, "connections are closed at the end of the pass");
});

Deno.test("new mail: one push per subscription, in each person's mode, with Topic and TTL; the cursor moves", async () => {
  const r = await rig();
  const mine = await r.subscribe(USER, "https://fcm.googleapis.com/fcm/send/mine");
  const theirs = await r.subscribe(OTHER_USER, "https://updates.push.services.mozilla.com/wpush/v2/theirs");
  r.store.prefs.set(`${OTHER_USER}:${INBOX}`, {
    inbox_id: INBOX,
    enabled: true,
    payload_mode: "private",
    quiet_start: null,
    quiet_end: null,
    quiet_timezone: null,
  });
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: imapCursor(101, 41, 4) });
  r.mail.rows.set(INBOX, [
    { id: "INBOX:100", from: SECRET_FROM, subject: SECRET_SUBJECT, unread: true },
    { id: "INBOX:99", from: "Old <old@x.example>", subject: "Old", unread: true },
  ]);
  const summary = await runDispatch(r.deps);
  assertEquals([summary.arrivals, summary.notified, summary.pushes_sent], [1, 1, 2]);
  assertEquals(r.sender.sent.length, 2);
  const byEndpoint = new Map(r.sender.sent.map((m) => [m.endpoint, m]));
  const rich = byEndpoint.get(mine.endpoint)!.payload as NewMailPayload;
  assertEquals([rich.mode, rich.title, rich.body, rich.count, rich.unread], ["rich", "Maya Berg", SECRET_SUBJECT, 1, 4]);
  const plain = byEndpoint.get(theirs.endpoint)!.payload as NewMailPayload;
  assertEquals([plain.mode, plain.title, plain.body], ["private", "New mail", `1 new message in ${SECRET_LABEL}`]);
  assert(!JSON.stringify(plain).includes("Maya") && !JSON.stringify(plain).includes("Kvartalsrapport"), "private carries no sender or subject");
  for (const message of r.sender.sent) {
    assertEquals(message.topic, topicFor(INBOX));
    assertEquals(message.ttlSec, NEW_MAIL_TTL_SEC);
    assertEquals((message.payload as NewMailPayload).tag, `mail-${INBOX}`);
  }
  assertEquals(r.store.watches[0].folders, { inbox: imapCursor(101, 41, 4) });
  assert(r.store.watches[0].last_notified_at !== null);
  assert(r.store.subs.every((s) => s.last_success_at !== null));
});

Deno.test("a flag-only change moves the cursor and notifies nobody", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: imapCursor(100, 40, 3) });
  await pass(r);
  // Someone read a message and starred another.
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: { fingerprint: "i:1700000000:100:40:2:-:k3j2", total: 40, unread: 2 } });
  const summary = await runDispatch(r.deps);
  assertEquals([summary.checked, summary.arrivals, summary.pushes_sent], [1, 0, 0]);
  assertEquals(r.sender.sent.length, 0);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 0, "the mailbox is not read for a notification nobody gets");
  assertEquals(r.store.watches[0].folders["inbox"].unread, 2);
  assert(r.store.watches[0].last_changed_at !== null);
});

Deno.test("private-only recipients: the mailbox is never listed", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.prefs.set(`${USER}:${INBOX}`, { inbox_id: INBOX, enabled: true, payload_mode: "private", quiet_start: null, quiet_end: null, quiet_timezone: null });
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(103, 43, 6) });
  await runDispatch(r.deps);
  assertEquals(r.mail.calls.map((c) => c.op), ["probe", "probe"]);
  assertEquals((r.sender.sent[0].payload as NewMailPayload).body, "3 new messages in Work");
});

Deno.test("burst: several arrivals between two checks are ONE notification per device, and two bursts share a Topic and tag", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(107, 47, 10) });
  r.mail.rows.set(INBOX, [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `INBOX:${107 - n}`, from: `S${n} <s${n}@x.example>`, subject: `Subject ${n}`, unread: true })));
  await pass(r);
  assertEquals(r.sender.sent.length, 1, "seven messages, one push");
  const first = r.sender.sent[0].payload as NewMailPayload;
  assertEquals([first.count, first.title], [7, "7 new messages in Work"]);
  assertStringIncludes(first.body, "and 4 more");
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(108, 48, 11) });
  await pass(r);
  assertEquals(r.sender.sent.length, 2);
  assertEquals(r.sender.sent[0].topic, r.sender.sent[1].topic, "the push service replaces an undelivered first with the second");
  assertEquals((r.sender.sent[0].payload as NewMailPayload).tag, (r.sender.sent[1].payload as NewMailPayload).tag, "and so does the screen");
});

Deno.test("Gmail: history decides. Added ids are announced; a change with nothing added is not; an expired id resets", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX, provider: "gmail", mail_host: null });
  r.mail.boxes.set(INBOX, { label: "Gmail", cursor: { fingerprint: "g:9001", total: 40, unread: 3 } });
  await pass(r);

  r.mail.boxes.set(INBOX, { label: "Gmail", cursor: { fingerprint: "g:9050", total: 40, unread: 2 } });
  r.mail.added.set(INBOX, []);
  let summary = await pass(r);
  assertEquals([summary.arrivals, r.sender.sent.length], [0, 0], "an archive or a label change");

  r.mail.boxes.set(INBOX, { label: "Gmail", cursor: { fingerprint: "g:9100", total: 42, unread: 4 } });
  r.mail.added.set(INBOX, ["g-new-2", "g-new-1"]);
  r.mail.rows.set(INBOX, [
    { id: "g-new-2", from: "B <b@x.example>", subject: "Second", unread: true },
    { id: "g-unrelated", from: "Z <z@x.example>", subject: "Unrelated unread", unread: true },
    { id: "g-new-1", from: "A <a@x.example>", subject: "First", unread: true },
  ]);
  summary = await pass(r);
  assertEquals(summary.arrivals, 1);
  const payload = r.sender.sent[0].payload as NewMailPayload;
  assertEquals(payload.count, 2);
  assertEquals(payload.body, "B: Second\nA: First", "only the messages history named");

  r.mail.boxes.set(INBOX, { label: "Gmail", cursor: { fingerprint: "g:9900", total: 60, unread: 20 } });
  r.mail.added.set(INBOX, null);
  summary = await pass(r);
  assertEquals([summary.arrivals, r.sender.sent.length], [0, 1], "history id too old: start again, quietly");
  assertEquals(r.store.watches[0].folders["inbox"].fingerprint, "g:9900");

  // History fails for another reason: the label counters decide.
  r.mail.boxes.set(INBOX, { label: "Gmail", cursor: { fingerprint: "g:9950", total: 61, unread: 21 } });
  r.mail.added.set(INBOX, new ApiError(502, "provider_error", "history failed"));
  summary = await pass(r);
  assertEquals([summary.arrivals, r.sender.sent.length], [1, 2]);
});

Deno.test("a stale cursor (the watcher was off for hours) is treated as a first observation", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await runDispatch(r.deps);
  r.advance(7 * 60 * 60_000);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(160, 100, 63) });
  const summary = await runDispatch(r.deps);
  assertEquals([summary.arrivals, r.sender.sent.length], [0, 0]);
  assertEquals(r.store.watches[0].folders["inbox"].total, 100);
});

Deno.test("quiet hours and a switched-off mailbox: those people are skipped, the others are told", async () => {
  const r = await rig({ start: Date.UTC(2026, 9, 5, 21, 30) }); // 23:30 in Oslo
  await r.subscribe(USER, "https://fcm.googleapis.com/fcm/send/quiet");
  await r.subscribe(OTHER_USER, "https://fcm.googleapis.com/fcm/send/awake");
  r.store.prefs.set(`${USER}:${INBOX}`, { inbox_id: INBOX, enabled: true, payload_mode: "rich", quiet_start: 22 * 60, quiet_end: 7 * 60, quiet_timezone: "Europe/Oslo" });
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(101, 41, 4) });
  await pass(r);
  assertEquals(r.sender.sent.map((m) => m.endpoint), ["https://fcm.googleapis.com/fcm/send/awake"]);
  // The awake one now switches this mailbox off: nobody is left to tell.
  r.store.prefs.set(`${OTHER_USER}:${INBOX}`, { inbox_id: INBOX, enabled: false, payload_mode: "rich", quiet_start: null, quiet_end: null, quiet_timezone: null });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(102, 42, 5) });
  await pass(r);
  assertEquals(r.sender.sent.length, 1);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 1, "and the mailbox is not listed for nobody");
});

Deno.test("dead subscriptions: 404/410 disables the row, a failure is counted, and the rest are still delivered", async () => {
  const r = await rig();
  const gone = await r.subscribe(USER, "https://fcm.googleapis.com/fcm/send/gone");
  const flaky = await r.subscribe(USER, "https://fcm.googleapis.com/fcm/send/flaky");
  const good = await r.subscribe(USER, "https://fcm.googleapis.com/fcm/send/good");
  r.sender.answer = (m) =>
    m.endpoint === gone.endpoint
      ? { kind: "gone", status: 410, attempts: 1 }
      : m.endpoint === flaky.endpoint
      ? { kind: "failed", status: 503, attempts: 3 }
      : { kind: "sent", status: 201, attempts: 1 };
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(101, 41, 4) });
  const summary = await pass(r);
  assertEquals([summary.pushes_sent, summary.pushes_failed, summary.subscriptions_gone, summary.notified], [1, 1, 1, 1]);
  assert(r.store.subs.find((s) => s.id === gone.id)!.disabled_at !== null);
  assertEquals(r.store.subs.find((s) => s.id === flaky.id)!.failure_count, 1);
  assert(r.store.subs.find((s) => s.id === good.id)!.last_success_at !== null);
  // The disabled one is not sent to again.
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(102, 42, 5) });
  await pass(r);
  assert(!r.sender.sent.slice(3).some((m) => m.endpoint === gone.endpoint));
});

Deno.test("413 from a push service: the count-only message is sent instead", async () => {
  const r = await rig();
  await r.subscribe();
  r.sender.answer = (m) =>
    (m.payload as NewMailPayload).mode === "rich" ? { kind: "too_large", status: 413, attempts: 1 } : { kind: "sent", status: 201, attempts: 1 };
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(101, 41, 4) });
  r.mail.rows.set(INBOX, [{ id: "m", from: SECRET_FROM, subject: SECRET_SUBJECT, unread: true }]);
  const summary = await pass(r);
  assertEquals(r.sender.sent.map((m) => (m.payload as NewMailPayload).mode), ["rich", "private"]);
  assertEquals(summary.pushes_sent, 1);
});

Deno.test("no VAPID keys: mailboxes are still checked and cursors kept, nothing is sent or listed", async () => {
  const r = await rig();
  await r.subscribe();
  r.deps.sender = null;
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(101, 41, 4) });
  const summary = await pass(r);
  assertEquals([summary.arrivals, summary.pushes_sent], [1, 0]);
  assertEquals(r.mail.calls.map((c) => c.op), ["probe", "probe"]);
  assertEquals(r.store.watches[0].folders["inbox"].total, 41);
});

// ── failure, backoff, reconnect ─────────────────────────────────────────────

Deno.test("backoff: exponential per consecutive failure, capped; longer for a refused credential", () => {
  assertEquals([1, 2, 3, 4, 5, 6, 9].map((n) => backoffMs("provider_error", n, "gmail") / 60_000), [2, 4, 8, 16, 32, 60, 60]);
  assertEquals([1, 2, 3, 7].map((n) => backoffMs("reconnect_required", n, "imap") / 60_000), [15, 30, 60, 720]);
  assertEquals(backoffMs("timeout", 1, "imap"), BACKOFF.provider.baseMs);
});

Deno.test("a failing mailbox backs off exponentially, keeps its cursor, and recovers", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  await pass(r);
  r.mail.boxes.set(INBOX, new ApiError(502, "provider_error", `connect failed for ${SECRET_LABEL}`, { retryable: true }));
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = r.now();
    const summary = await runDispatch(r.deps);
    assertEquals(summary.failed, 1);
    const row = r.store.watches[0];
    assertEquals(row.failure_count, i + 1);
    assertEquals(row.last_error_code, "provider_error");
    assertEquals(row.folders, { inbox: imapCursor(100, 40, 3) }, "the cursor survives a failure");
    waits.push(Date.parse(row.backoff_until!) - before);
    // Inside the backoff nothing is leased.
    r.advance(60_000);
    assertEquals((await runDispatch(r.deps)).leased, 0);
    r.advance(Date.parse(row.backoff_until!) - r.now());
  }
  assertEquals(waits.map((ms) => ms / 60_000), [2, 4, 8]);
  // It answers again, with mail that arrived meanwhile.
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(101, 41, 4) });
  const summary = await runDispatch(r.deps);
  assertEquals([summary.failed, summary.arrivals, summary.pushes_sent], [0, 1, 1]);
  assertEquals([r.store.watches[0].failure_count, r.store.watches[0].backoff_until, r.store.watches[0].last_error_code], [0, null, null]);
});

Deno.test("a refused credential backs off for a long time", async () => {
  const r = await rig();
  await r.subscribe();
  r.store.watch({ inbox_id: INBOX });
  r.mail.boxes.set(INBOX, new ApiError(409, "reconnect_required", "refused", { toolCode: "auth_failed" }));
  const before = r.now();
  const summary = await runDispatch(r.deps);
  assertEquals(summary.failed, 1);
  assertEquals(r.store.watches[0].last_error_code, "reconnect_required");
  assertEquals(Date.parse(r.store.watches[0].backoff_until!) - before, 15 * 60_000);
});

Deno.test("an inbox whose row carries a fresh refused-login marker is not dialled at all", async () => {
  const r = await rig();
  await r.subscribe();
  const refusedAt = r.now() - 2 * 60_000;
  r.store.watch({ inbox_id: INBOX, inbox_last_error: loginRefusedMarker(refusedAt) });
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(100, 40, 3) });
  const summary = await runDispatch(r.deps);
  assertEquals([summary.leased, summary.skipped_reconnect, summary.failed], [1, 1, 0]);
  assertEquals(r.mail.calls.length, 0, "no connection to the mail host");
  assertEquals(Date.parse(r.store.watches[0].next_check_at), refusedAt + 10 * 60_000);
  // Once the window has passed it is tried again.
  r.advance(9 * 60_000);
  assertEquals((await runDispatch(r.deps)).checked, 1);
  assertEquals(r.mail.calls.length, 1);
});

Deno.test("a check that hangs is abandoned at its timeout and counted as a failure", async () => {
  const r = await rig();
  r.deps.checkTimeoutMs = 20;
  r.store.watch({ inbox_id: INBOX });
  let release: () => void = () => {};
  r.mail.boxes.set(INBOX, () => new Promise((resolve) => {
    release = () => resolve({ label: "Work", cursor: imapCursor(1, 1, 1) });
  }));
  const summary = await runDispatch(r.deps);
  release();
  assertEquals(summary.failed, 1);
  assertEquals(r.store.watches[0].last_error_code, "timeout");
});

// ── leasing, caps, budget ───────────────────────────────────────────────────

Deno.test("a pass leases a bounded batch; a mailbox leased by one pass is not leased by another", async () => {
  const r = await rig();
  for (let n = 1; n <= BATCH_SIZE + 5; n++) {
    r.store.watch({ inbox_id: inboxId(n), mail_host: `host-${n}.example` });
    r.mail.boxes.set(inboxId(n), { label: "Work", cursor: imapCursor(1, 1, 0) });
  }
  const first = await r.store.leaseWatches(BATCH_SIZE, 120);
  assertEquals(first.length, BATCH_SIZE);
  const second = await r.store.leaseWatches(BATCH_SIZE, 120);
  assertEquals(second.length, 5, "the second pass gets only what the first did not take");
  assertEquals(new Set([...first, ...second].map((w) => w.inbox_id)).size, BATCH_SIZE + 5, "no mailbox twice");
  assertEquals((await r.store.leaseWatches(BATCH_SIZE, 120)).length, 0);
});

Deno.test("a result written with a lease that no longer holds the row changes nothing", async () => {
  const r = await rig();
  r.store.watch({ inbox_id: INBOX });
  const [leased] = await r.store.leaseWatches(1, 120);
  // The lease expired and another pass took the row.
  r.store.watches[0].lease_id = crypto.randomUUID();
  r.mail.boxes.set(INBOX, { label: "Work", cursor: imapCursor(9, 9, 9) });
  const { checkWatch } = await import("../push/dispatch.ts");
  await checkWatch(r.deps, leased);
  assertEquals(r.store.releases.at(-1)!.applied, false);
  assertEquals(r.store.watches[0].folders, {});
});

Deno.test("concurrency: never more than the global, per-provider and per-host caps in flight", async () => {
  const r = await rig();
  // 12 IMAP mailboxes on one host, 8 on separate hosts.
  for (let n = 1; n <= 20; n++) {
    r.store.watch({ inbox_id: inboxId(n), mail_host: n <= 12 ? "IMAP.shared.example" : `imap-${n}.example` });
    r.mail.boxes.set(inboxId(n), () => new Promise((resolve) => setTimeout(() => resolve({ label: "Work", cursor: imapCursor(1, 1, 0) }), 2)));
  }
  const summary = await runDispatch(r.deps);
  assertEquals(summary.checked, 20);
  assert(r.mail.maxInFlight <= Math.min(MAX_CONCURRENCY, PROVIDER_CONCURRENCY["imap"]), `in flight: ${r.mail.maxInFlight}`);
  assert(r.mail.maxInFlight > 1, "checks do run side by side");
  assert(r.mail.maxPerHost <= HOST_CONCURRENCY, `per host: ${r.mail.maxPerHost}`);
  assertEquals(new Set(r.mail.calls.map((c) => c.inbox_id)).size, 20, "each mailbox checked once");
});

Deno.test("budget: when time runs out no new check starts, and the rest go back to the front of the queue", async () => {
  const r = await rig();
  r.deps.budgetMs = 1000;
  for (let n = 1; n <= 12; n++) {
    r.store.watch({ inbox_id: inboxId(n), mail_host: "one-host.example" });
    // Each check "takes" 400 ms of the pass's clock.
    r.mail.boxes.set(inboxId(n), () => {
      r.advance(400);
      return Promise.resolve({ label: "Work", cursor: imapCursor(1, 1, 0) });
    });
  }
  const startedAt = r.now();
  const summary = await runDispatch(r.deps);
  assertEquals(summary.leased, 12);
  assert(summary.checked >= 2 && summary.checked < 12, `checked ${summary.checked}`);
  assertEquals(summary.checked + summary.deferred, 12);
  const untouched = r.store.watches.filter((w) => w.last_checked_at === null);
  assertEquals(untouched.length, summary.deferred);
  for (const w of untouched) {
    assertEquals(w.lease_id, null, "handed back");
    assertEquals(Date.parse(w.next_check_at), startedAt, "due at once");
    assertEquals(w.failure_count, 0, "running out of time is not a failure");
  }
  // The next pass picks the deferred ones first.
  r.deps.budgetMs = 60_000;
  const next = await runDispatch(r.deps);
  assertEquals(next.checked, summary.deferred);
});

Deno.test("nothing due: one lease call and no mailbox contacted", async () => {
  const r = await rig();
  const summary = await runDispatch(r.deps);
  assertEquals([summary.leased, summary.checked], [0, 0]);
  assertEquals(r.mail.calls.length, 0);
});

Deno.test("a lease that fails is one log line and an empty pass, not an exception", async () => {
  const r = await rig();
  r.store.leaseWatches = () => Promise.reject(new Error(`db down while reading ${SECRET_LABEL}`));
  const summary = await runDispatch(r.deps);
  assertEquals(summary.leased, 0);
  assertEquals(r.logs.map((l) => l.event), ["push_dispatch_failed"]);
  assert(!JSON.stringify(r.logs).includes("mailbox-secret"));
});

// ── privacy ─────────────────────────────────────────────────────────────────

Deno.test("no mail content in the log or the store: not a sender, a subject, an address or a mailbox name", async () => {
  const r = await rig();
  await r.subscribe(USER, "https://fcm.googleapis.com/fcm/send/rich");
  await r.subscribe(OTHER_USER, "https://fcm.googleapis.com/fcm/send/gone");
  r.sender.answer = (m) => m.endpoint.endsWith("/gone") ? { kind: "gone", status: 410, attempts: 1 } : { kind: "sent", status: 201, attempts: 1 };
  r.store.watch({ inbox_id: INBOX, mail_host: "imap.shared-host.example" });
  r.store.watch({ inbox_id: inboxId(2), mail_host: "imap.shared-host.example" });
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: imapCursor(100, 40, 3) });
  r.mail.boxes.set(inboxId(2), new ApiError(502, "provider_error", `LOGIN failed for ${SECRET_LABEL}: ${SECRET_SUBJECT}`));
  await pass(r);
  r.mail.boxes.set(INBOX, { label: SECRET_LABEL, cursor: imapCursor(102, 42, 5) });
  r.mail.rows.set(INBOX, [
    { id: "INBOX:101", from: SECRET_FROM, subject: SECRET_SUBJECT, unread: true },
    { id: "INBOX:100", from: SECRET_FROM, subject: `Re: ${SECRET_SUBJECT}`, unread: true },
  ]);
  const summary = await runDispatch(r.deps);
  assertEquals(summary.pushes_sent, 1);
  // The notification itself does carry them (encrypted to the browser by the real sender).
  assertStringIncludes(JSON.stringify(r.sender.sent[0].payload), "Kvartalsrapport");

  const logged = JSON.stringify(r.logs);
  const stored = JSON.stringify({ watches: r.store.watches, releases: r.store.releases, results: r.store.results });
  for (const secret of SECRETS) {
    assert(!logged.includes(secret), `log contains "${secret}"`);
    assert(!stored.includes(secret), `store contains "${secret}"`);
  }
  // No logged value is a push endpoint, whole or in part: none parses as a URL on a push service.
  const endpoints = r.store.subs.map((s) => new URL(s.endpoint));
  assert(endpoints.length > 0);
  for (const endpoint of endpoints) {
    assert(!logged.includes(endpoint.href) && !logged.includes(endpoint.pathname), "push endpoints are not logged");
    assert(!logged.toLowerCase().includes(endpoint.hostname), "nor is the host of one");
  }
  // What IS logged: ids, a provider word, outcome words, counts, timings.
  const allowed = new Set([
    "inbox_id", "workspace_id", "provider", "outcome", "error_code", "recipients", "pushes_sent", "pushes_failed",
    "subscriptions_gone", "ms", "leased", "checked", "arrivals", "notified", "failed", "skipped_reconnect", "deferred",
  ]);
  for (const line of r.logs) {
    for (const key of Object.keys(line.fields)) assert(allowed.has(key), `unexpected log field ${key}`);
  }
  assert(r.logs.some((l) => l.event === "push_watch" && l.fields["outcome"] === "new_mail"));
  assert(r.logs.some((l) => l.event === "push_watch" && l.fields["error_code"] === "provider_error"));
  // The stored cursor is numbers only.
  assertEquals(Object.keys(r.store.watches[0].folders["inbox"]).sort(), ["fingerprint", "total", "unread"]);
});
