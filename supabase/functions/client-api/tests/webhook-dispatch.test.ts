// Webhooks as the second consumer of the new-mail watcher: an arrival
// enqueues one delivery per matching endpoint, the payload carries the ids
// the MCP tools take, `headers` mode adds sender and subject, a workspace
// whose plan no longer allows webhooks is paused, and nothing read from a
// mailbox reaches the log. In-memory fakes; no network.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type DispatchDeps, runDispatch } from "../push/dispatch.ts";
import type { WebhookDeps } from "../webhooks/deliver.ts";
import { EVENT_ID_HEADER, SIGNATURE_HEADER, verifySignature } from "../webhooks/sign.ts";
import { fakeMail, fakePushStore, fakeSender, imapCursor } from "./push-fakes.ts";
import { fakeDecrypt, fakeTransport, fakeWebhookStore } from "./webhook-fakes.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "33333333-3333-4333-8333-333333333333";
const inboxId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const INBOX = inboxId(1);
const SECRET_FROM = "Maya Berg <maya.berg@north-secret.example>";
const SECRET_SUBJECT = "Kvartalsrapport: konfidensielt utkast";

function rig() {
  let clock = Date.UTC(2026, 9, 24, 12, 0, 0);
  const now = () => clock;
  const store = fakePushStore(now, WS);
  const mail = fakeMail();
  const sender = fakeSender();
  const hooks = fakeWebhookStore(now);
  const transport = fakeTransport();
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown>) => logs.push({ event, fields });
  const disabled: string[] = [];
  const webhooks: WebhookDeps = {
    store: hooks,
    transport,
    decrypt: fakeDecrypt,
    now,
    log,
    onEndpointDisabled: (id) => {
      disabled.push(id);
      return Promise.resolve();
    },
  };
  const deps: DispatchDeps = { store, mail, sender, webhooks, now, log };
  hooks.allowed.add(WS);
  hooks.inboxes.set(INBOX, { workspace_id: WS, provider: "imap" });
  hooks.inboxes.set(inboxId(2), { workspace_id: WS, provider: "imap" });
  return { store, mail, sender, hooks, transport, logs, deps, disabled, now, advance: (ms: number) => void (clock += ms) };
}

/** First pass records the cursor; the second sees two new messages. */
async function arrive(r: ReturnType<typeof rig>, inbox = INBOX) {
  r.store.watch({ inbox_id: inbox });
  r.mail.boxes.set(inbox, { label: "Support", cursor: imapCursor(100, 40, 3) });
  await runDispatch(r.deps);
  r.advance(120_000);
  r.mail.boxes.set(inbox, { label: "Support", cursor: imapCursor(102, 42, 5) });
  r.mail.rows.set(inbox, [
    { id: "INBOX:101", from: SECRET_FROM, subject: SECRET_SUBJECT, unread: true },
    { id: "INBOX:100", from: "Ola <ola@example.test>", subject: "Hei", unread: true },
    { id: "INBOX:90", from: "Old <old@example.test>", subject: "Read already", unread: false },
  ]);
  return await runDispatch(r.deps);
}

Deno.test("an arrival enqueues one delivery per matching endpoint and posts a signed event", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep-all", workspace_id: WS });
  r.hooks.endpoint({ id: "ep-pinned-here", workspace_id: WS, inbox_ids: [INBOX] });
  r.hooks.endpoint({ id: "ep-pinned-elsewhere", workspace_id: WS, inbox_ids: [inboxId(2)] });
  r.hooks.endpoint({ id: "ep-other-ws", workspace_id: OTHER_WS });
  r.hooks.endpoint({ id: "ep-disabled", workspace_id: WS, disabled_at: "2026-10-01T00:00:00.000Z", disabled_reason: "manual" });

  const summary = await arrive(r);
  assertEquals(summary.arrivals, 1);
  assertEquals(summary.webhooks_enqueued, 2);
  assertEquals(summary.webhooks_delivered, 2);
  assertEquals(r.hooks.deliveries.map((d) => d.endpoint_id).sort(), ["ep-all", "ep-pinned-here"]);
  assertEquals(r.hooks.deliveries.map((d) => d.status), ["delivered", "delivered"]);
  assert(r.hooks.deliveries.every((d) => d.message_ids === null), "ids are cleared once delivered");

  assertEquals(r.transport.sent.length, 2);
  const first = r.transport.sent.find((s) => s.url.endsWith("/ep-all"))!;
  const event = JSON.parse(first.body);
  assertEquals(event.type, "message.received");
  assertEquals(event.workspace_id, WS);
  assertEquals(event.inbox_id, INBOX);
  assertEquals(event.folder, "INBOX");
  assertEquals(event.count, 2);
  assertEquals(event.message_ids, ["INBOX:101", "INBOX:100"]);
  assert(/^evt_[0-9a-f]{32}$/.test(event.id));
  assertEquals(event.messages, undefined, "ids mode carries no sender or subject");
  assertEquals(first.headers[EVENT_ID_HEADER], event.id);
  // The same event (one id) goes to every endpoint, each signed with its own secret.
  const second = r.transport.sent.find((s) => s.url.endsWith("/ep-pinned-here"))!;
  assertEquals(JSON.parse(second.body).id, event.id);
  const nowSec = Math.floor(r.now() / 1000);
  assert(await verifySignature(first.headers[SIGNATURE_HEADER], "whsec_ep-all", first.body, nowSec));
  assert(!await verifySignature(first.headers[SIGNATURE_HEADER], "whsec_ep-pinned-here", first.body, nowSec));
});

Deno.test("headers mode adds sender and subject per message, from the same read push uses", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep-h", workspace_id: WS, payload_mode: "headers" });
  await arrive(r);
  const event = JSON.parse(r.transport.sent[0].body);
  assertEquals(event.messages, [
    { id: "INBOX:101", from: SECRET_FROM, subject: SECRET_SUBJECT },
    { id: "INBOX:100", from: "Ola <ola@example.test>", subject: "Hei" },
  ]);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 1, "one list read, no body read");
});

Deno.test("a rich push recipient and a webhook share one mailbox read", async () => {
  const r = rig();
  await r.store.upsertSubscription({
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: WS,
    endpoint: "https://fcm.googleapis.com/fcm/send/device",
    p256dh: "A".repeat(87),
    auth: "a".repeat(22),
    userAgent: null,
  });
  r.hooks.endpoint({ id: "ep-h", workspace_id: WS, payload_mode: "headers" });
  const summary = await arrive(r);
  assertEquals(summary.pushes_sent, 1);
  assertEquals(summary.webhooks_delivered, 1);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 1);
});

Deno.test("a workspace whose plan no longer allows webhooks is paused: nothing enqueued, the mailbox is not read", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep-all", workspace_id: WS });
  r.hooks.allowed.delete(WS);
  const summary = await arrive(r);
  assertEquals(summary.arrivals, 1);
  assertEquals(summary.webhooks_enqueued, 0);
  assertEquals(r.hooks.deliveries.length, 0);
  assertEquals(r.transport.sent.length, 0);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 0);
  // The endpoint itself is kept, untouched.
  assertEquals(r.hooks.endpoints[0].disabled_at, null);
});

Deno.test("without webhook deps the watcher behaves exactly as before", async () => {
  const r = rig();
  r.deps.webhooks = null;
  r.hooks.endpoint({ id: "ep-all", workspace_id: WS });
  const summary = await arrive(r);
  assertEquals(summary.webhooks_enqueued, 0);
  assertEquals(r.hooks.hasTargetsCalls, 0);
});

Deno.test("Gmail: the ids history named are the event's ids", async () => {
  const r = rig();
  const GMAIL = inboxId(7);
  r.hooks.inboxes.set(GMAIL, { workspace_id: WS, provider: "gmail" });
  r.hooks.endpoint({ id: "ep-all", workspace_id: WS });
  r.store.watch({ inbox_id: GMAIL, provider: "gmail", mail_host: null });
  r.mail.boxes.set(GMAIL, { label: "G", cursor: { fingerprint: "g:1000", total: 10, unread: 1 } });
  await runDispatch(r.deps);
  r.advance(60_000);
  r.mail.boxes.set(GMAIL, { label: "G", cursor: { fingerprint: "g:1010", total: 11, unread: 2 } });
  r.mail.added.set(GMAIL, ["18c2a"]);
  r.mail.rows.set(GMAIL, [
    { id: "18c2a", from: "A", subject: "S", unread: true },
    { id: "18c29", from: "B", subject: "T", unread: true },
  ]);
  await runDispatch(r.deps);
  assertEquals(JSON.parse(r.transport.sent[0].body).message_ids, ["18c2a"]);
});

Deno.test("a failed first attempt is scheduled for a retry one minute later, with its ids kept", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep-all", workspace_id: WS });
  r.transport.answer = () => ({ kind: "response", status: 503 });
  const summary = await arrive(r);
  assertEquals(summary.webhooks_failed, 1);
  const d = r.hooks.deliveries[0];
  assertEquals([d.status, d.attempt, d.response_code, d.error_code], ["pending", 1, 503, "http_status"]);
  assertEquals(d.next_attempt_at! - r.now(), 60_000);
  assertEquals(d.message_ids, ["INBOX:101", "INBOX:100"]);
});

Deno.test("no mail content in the log or the delivery rows", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep-h", workspace_id: WS, payload_mode: "headers" });
  r.transport.answer = () => ({ kind: "response", status: 500 });
  await arrive(r);
  const logged = JSON.stringify(r.logs);
  const stored = JSON.stringify(r.hooks.deliveries);
  for (const secret of ["Maya", "north-secret", "Kvartalsrapport", "konfidensielt", "Support"]) {
    assert(!logged.includes(secret), `log contains "${secret}"`);
    assert(!stored.includes(secret), `deliveries contain "${secret}"`);
  }
  assert(!logged.includes("hooks.receiver.example"), "the endpoint URL is not logged");
});

Deno.test("every pass logs its capacity: duration, leased and unreached", async () => {
  const r = rig();
  for (let n = 1; n <= 5; n++) {
    r.store.watch({ inbox_id: inboxId(n) });
    r.mail.boxes.set(inboxId(n), { label: "x", cursor: imapCursor(1, 1, 0) });
  }
  r.deps.budgetMs = 0;
  await runDispatch(r.deps);
  const line = r.logs.find((l) => l.event === "watch_capacity");
  assert(line, "watch_capacity was logged");
  assertEquals(line.fields["leased"], 5);
  assertEquals(line.fields["unreached"], 5);
  assertEquals(typeof line.fields["ms"], "number");
  assertEquals(line.fields["batch_size"], 20);
});

Deno.test("BATCH_SIZE is c_batch in the newest dispatch_inbox_watch() definition", async () => {
  const { BATCH_SIZE } = await import("../push/dispatch.ts");
  const dir = new URL("../../../migrations/", import.meta.url);
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) if (entry.name.endsWith(".sql")) files.push(entry.name);
  files.sort();
  let latest: string | null = null;
  for (const name of files) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    if (/CREATE OR REPLACE FUNCTION public\.dispatch_inbox_watch\(\)/.test(sql)) latest = sql;
  }
  assert(latest, "a migration defines dispatch_inbox_watch()");
  const match = /c_batch\s+constant integer := (\d+);/.exec(latest);
  assertEquals(Number(match?.[1]), BATCH_SIZE);
});
