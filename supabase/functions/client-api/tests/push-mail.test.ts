// The watcher's mailbox reads (push/mail.ts) against the REAL tool layer: the
// scripted fake IMAP server and the provider harness's fake fetch. This is the
// contract between mail/status.ts's fingerprints and push/notify.ts's reading
// of them, and the proof of what a check costs the mail host.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type FakeMailbox, fakeTextMessage } from "../../mcp-server/imap-fake-server.ts";
import { ApiError } from "../errors.ts";
import { runDispatch } from "../push/dispatch.ts";
import { createWatchMail, type WatchTarget } from "../push/mail.ts";
import { detectArrival, type NewMailPayload, parseGmailFingerprint, parseImapFingerprint } from "../push/notify.ts";
import { keyRow } from "./helpers.ts";
import { browserKeys, fakePushStore, fakeSender } from "./push-fakes.ts";
import { FakeDialPool, gmailHandler, type GmailWorld, harness, imapInbox, imapServer, INBOX_ID, mcp, WORKSPACE } from "./real-seam.ts";

const WATCH: WatchTarget = { inbox_id: INBOX_ID, workspace_id: WORKSPACE, provider: "imap" };
const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);

function imapRig(options: { condstore?: boolean } = {}) {
  const boxes: FakeMailbox[] = [{
    name: "INBOX",
    attrs: ["\\HasNoChildren"],
    ...(options.condstore === false ? {} : { modSeq: 100 }),
    messages: [fakeTextMessage(1, { seen: true }), fakeTextMessage(2, { subject: "Already here" })],
  }];
  const pool = new FakeDialPool(imapServer(boxes));
  const refused: string[] = [];
  const mail = createWatchMail({
    mcp,
    pool,
    imapDial: pool.dial,
    workspaceKey: (workspaceId) => Promise.resolve(keyRow(workspaceId)),
    onLoginRefused: (inboxId) => refused.push(inboxId),
  });
  return { boxes, pool, mail, refused };
}

Deno.test("probe (imap): one STATUS, no SELECT and no FETCH, and a cursor notify.ts can read", async () => {
  const { pool, mail } = imapRig();
  const { value } = await harness.runTool(await imapInbox(), noHandler, () => mail.probe(WATCH));
  assertEquals([value.cursor.total, value.cursor.unread], [2, 1]);
  const parsed = parseImapFingerprint(value.cursor.fingerprint);
  assert(parsed !== null, `unreadable fingerprint ${value.cursor.fingerprint}`);
  assertEquals(parsed.uidNext, 3);
  assertEquals(value.label, "Harness Owner", "the mailbox display name");
  const commands = pool.servers[0].commands;
  assertEquals(commands.filter((c) => /STATUS/.test(c)).length, 1);
  assertEquals(commands.filter((c) => /SELECT|EXAMINE|FETCH/.test(c)).length, 0, commands.join(" | "));
  await mail.close();
  assertEquals(pool.servers[0].logoutReceived, true, "close() logs the connection out");
});

Deno.test("probe (imap, no CONDSTORE): the watcher skips the flags digest the client's own poll pays for", async () => {
  const { pool, mail } = imapRig({ condstore: false });
  await harness.runTool(await imapInbox(), noHandler, () => mail.probe(WATCH));
  assertEquals(pool.servers[0].commands.filter((c) => /SELECT|EXAMINE|FETCH/.test(c)).length, 0);
  await mail.close();
});

Deno.test("imap end to end: a new message is new mail, a read is not; the rich rows are the newest unread", async () => {
  const { boxes, pool, mail } = imapRig();
  const inbox = await imapInbox();
  const run = <T>(body: () => Promise<T>) => harness.runTool(inbox, noHandler, body).then((r) => r.value);
  const first = await run(() => mail.probe(WATCH));

  boxes[0].messages.find((m) => m.uid === 2)!.flags = ["\\Seen"];
  if (boxes[0].modSeq !== undefined) boxes[0].modSeq++;
  const afterRead = await run(() => mail.probe(WATCH));
  assertEquals(detectArrival("imap", first.cursor, afterRead.cursor), { kind: "changed" });

  boxes[0].messages.push(fakeTextMessage(3, { subject: "Fresh arrival" }));
  if (boxes[0].modSeq !== undefined) boxes[0].modSeq++;
  const afterNew = await run(() => mail.probe(WATCH));
  assertEquals(detectArrival("imap", afterRead.cursor, afterNew.cursor), { kind: "new", count: 1 });

  const rows = await run(() => mail.newest(WATCH, 5));
  assertEquals(rows.map((r) => [r.id, r.subject, r.unread]), [
    ["INBOX:3", "Fresh arrival", true],
    ["INBOX:2", "Already here", false],
    ["INBOX:1", "Message 1", false],
  ]);
  assert(rows[0].from.length > 0, "the sender is read");
  assertEquals(pool.servers.length, 1, "probe and list shared one connection");
  assertEquals(pool.servers[0].commands.filter((c) => /BODY\[(TEXT|1)?\]|BODY\.PEEK\[(TEXT|1)\]/.test(c)).length, 0, "no body bytes for a notification");
  await mail.close();
});

Deno.test("a refused IMAP login is a reconnect_required ApiError and is reported for the row marker", async () => {
  const { pool, mail, refused } = imapRig();
  const failing = createWatchMail({
    mcp,
    pool,
    imapDial: () => {
      const error = new Error("LOGIN failed");
      error.name = "ImapAuthError";
      return Promise.reject(error);
    },
    workspaceKey: (workspaceId) => Promise.resolve(keyRow(workspaceId)),
    onLoginRefused: (inboxId) => refused.push(inboxId),
  });
  const { value } = await harness.runTool(await imapInbox(), noHandler, () => failing.probe(WATCH).catch((e) => e));
  assert(value instanceof ApiError, String(value));
  assertEquals(value.body.code, "reconnect_required");
  await failing.close();
  await mail.close();
});

function gmailWorld(): GmailWorld {
  return {
    historyId: "9001",
    sent: [],
    modified: [],
    messages: [
      { id: "g1", from: "Maya <maya@north.example>", to: "owner@gmail-harness.example", subject: "Older", snippet: "x", labelIds: ["INBOX", "UNREAD"] },
    ],
  };
}

function withHistory(world: GmailWorld, history: () => Response): harness.ProviderHandler {
  const base = gmailHandler(world);
  return (call) => new URL(call.url).pathname.endsWith("/history") ? history() : base(call);
}

Deno.test("gmail: probe reads the historyId and label counters; history names the unread inbox additions only", async () => {
  const world = gmailWorld();
  const mail = createWatchMail({ mcp, workspaceKey: (workspaceId) => Promise.resolve(keyRow(workspaceId)) });
  const watch: WatchTarget = { ...WATCH, provider: "gmail" };
  const history = () =>
    harness.json({
      historyId: "9100",
      history: [
        { id: "9010", messagesAdded: [{ message: { id: "g2", labelIds: ["INBOX", "UNREAD"] } }] },
        { id: "9020", messagesAdded: [{ message: { id: "g2", labelIds: ["INBOX", "UNREAD"] } }, { message: { id: "sent-1", labelIds: ["SENT", "INBOX", "UNREAD"] } }] },
        { id: "9030", messagesAdded: [{ message: { id: "read-elsewhere", labelIds: ["INBOX"] } }, { message: { id: "draft-1", labelIds: ["DRAFT"] } }] },
        { id: "9040" },
      ],
    });
  const { value, world: run } = await harness.runTool(await harness.inboxRow("gmail"), withHistory(world, history), async () => {
    const probe = await mail.probe(watch);
    const added = await mail.gmailAdded(watch, "9001");
    return { probe, added };
  });
  assertEquals(parseGmailFingerprint(value.probe.cursor.fingerprint), "9001");
  assertEquals([value.probe.cursor.total, value.probe.cursor.unread], [1, 1]);
  assertEquals(value.added, ["g2"]);
  const historyCall = run.calls.find((c) => c.url.includes("/history"))!;
  const query = new URL(historyCall.url).searchParams;
  assertEquals([query.get("startHistoryId"), query.get("historyTypes"), query.get("labelId")], ["9001", "messageAdded", "INBOX"]);
  assertEquals(run.calls.filter((c) => c.url.includes("googleapis.com")).length, 3, "profile, the inbox label, history");
  await mail.close();
});

Deno.test("gmail: an expired history id is null (start again); a non-numeric one never reaches Google", async () => {
  const world = gmailWorld();
  const mail = createWatchMail({ mcp, workspaceKey: (workspaceId) => Promise.resolve(keyRow(workspaceId)) });
  const watch: WatchTarget = { ...WATCH, provider: "gmail" };
  const { value, world: run } = await harness.runTool(
    await harness.inboxRow("gmail"),
    withHistory(world, () => harness.json({ error: { code: 404 } }, 404)),
    async () => [await mail.gmailAdded(watch, "12"), await mail.gmailAdded(watch, "12&labelId=SENT")],
  );
  assertEquals(value, [null, null]);
  assertEquals(run.calls.filter((c) => c.url.includes("/history")).length, 1);
});

Deno.test("one dispatcher pass over the real tool layer: first look is silent, then one push with sender and subject", async () => {
  const { boxes, pool, mail } = imapRig();
  const inbox = await imapInbox();
  let clock = Date.UTC(2026, 9, 5, 12, 0, 0);
  const store = fakePushStore(() => clock, WORKSPACE);
  const sender = fakeSender();
  await store.upsertSubscription({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceId: WORKSPACE, endpoint: "https://fcm.googleapis.com/fcm/send/x", ...(await browserKeys()), userAgent: null });
  store.watch({ inbox_id: INBOX_ID, workspace_id: WORKSPACE });
  const logs: unknown[] = [];
  // `close` is a no-op here so the fake connection survives both passes.
  const deps = { store, sender, mail: { ...mail, close: () => Promise.resolve() }, now: () => clock, log: (event: string, fields: unknown) => logs.push({ event, fields }) };

  const first = await harness.runTool(inbox, noHandler, () => runDispatch(deps));
  assertEquals([first.value.checked, first.value.arrivals, sender.sent.length], [1, 0, 0]);

  clock += 120_000;
  boxes[0].messages.push(fakeTextMessage(3, { subject: "Fresh arrival" }));
  if (boxes[0].modSeq !== undefined) boxes[0].modSeq++;
  const second = await harness.runTool(inbox, noHandler, () => runDispatch(deps));
  assertEquals([second.value.arrivals, second.value.pushes_sent], [1, 1]);
  const payload = sender.sent[0].payload as NewMailPayload;
  assertEquals([payload.mode, payload.body, payload.count, payload.unread], ["rich", "Fresh arrival", 1, 2]);
  assert(payload.title.length > 0 && payload.title !== "Unknown sender", "the sender is in the title");
  assertEquals(payload.url, `/${INBOX_ID}/inbox/${encodeURIComponent(`${INBOX_ID}:INBOX:3`)}`);
  assert(!JSON.stringify(logs).includes("Fresh arrival") && !JSON.stringify(logs).includes("owner@example.com"));
  assert(!JSON.stringify(store.watches).includes("Fresh arrival"));
  await pool.closeAll();
});
