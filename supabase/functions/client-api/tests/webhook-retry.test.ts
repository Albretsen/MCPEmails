// The retry schedule (1 min, 5 min, 30 min, 2 h, 6 h, 24 h), the final
// failure, auto-disable after 24 hours of failure or 50 failures in a row
// (with one owner email), pausing on a plan change, headers mode on a retry,
// and the time budget. In-memory fakes; no network.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { type DispatchDeps, HOST_CONCURRENCY, PROVIDER_CONCURRENCY, runDispatch } from "../push/dispatch.ts";
import {
  DISABLE_AFTER_FAILURES,
  MAX_ATTEMPTS,
  nextAttemptAt,
  RETRY_DELAYS_MS,
  runSends,
  type WebhookDeps,
} from "../webhooks/deliver.ts";
import { loginRefusedMarker } from "../mail/health.ts";
import { fakeMail, fakePushStore, fakeSender } from "./push-fakes.ts";
import type { NewestRow, WatchMail } from "../push/mail.ts";
import { type FakeDelivery, fakeDecrypt, fakeTransport, fakeWebhookStore } from "./webhook-fakes.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const INBOX = "22222222-2222-4222-8222-000000000001";
const MIN = 60_000;
const HOUR = 60 * MIN;
const LIMITS = {
  providerConcurrency: PROVIDER_CONCURRENCY,
  hostConcurrency: HOST_CONCURRENCY,
  providerKey: (p: string) => (p === "gmail" || p === "outlook" ? p : "imap"),
};

function rig() {
  let clock = Date.UTC(2026, 9, 24, 12, 0, 0);
  const now = () => clock;
  const hooks = fakeWebhookStore(now);
  const transport = fakeTransport();
  const mail = fakeMail();
  const disabled: string[] = [];
  const logs: string[] = [];
  const deps: WebhookDeps = {
    store: hooks,
    transport,
    decrypt: fakeDecrypt,
    now,
    log: (event) => logs.push(event),
    onEndpointDisabled: (id) => {
      disabled.push(id);
      return Promise.resolve();
    },
  };
  hooks.allowed.add(WS);
  hooks.inboxes.set(INBOX, { workspace_id: WS, provider: "imap" });
  const pending = (id: string, extra: Partial<FakeDelivery> = {}): FakeDelivery => {
    const d: FakeDelivery = {
      id,
      endpoint_id: "ep",
      workspace_id: WS,
      event_id: `evt_${"a".repeat(31)}${id.slice(-1)}`,
      inbox_id: INBOX,
      message_ids: ["INBOX:7"],
      message_count: 1,
      attempt: 1,
      status: "pending",
      response_code: 500,
      error_code: "http_status",
      next_attempt_at: clock,
      lease_id: null,
      leased_until: null,
      created_at: new Date(clock - MIN).toISOString(),
      ...extra,
    };
    hooks.deliveries.push(d);
    return d;
  };
  return {
    hooks,
    transport,
    mail,
    deps,
    disabled,
    logs,
    now,
    pending,
    advance: (ms: number) => void (clock += ms),
    retry: () => runSends(deps, mail, { deadlineMs: clock + 40_000, limits: LIMITS }),
  };
}

Deno.test("the schedule: 1 min, 5 min, 30 min, 2 h, 6 h, 24 h, then no more", () => {
  assertEquals(RETRY_DELAYS_MS, [MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR, 24 * HOUR]);
  assertEquals(MAX_ATTEMPTS, 7);
  const t0 = 1_000_000;
  assertEquals([1, 2, 3, 4, 5, 6].map((n) => nextAttemptAt(n, t0)! - t0), RETRY_DELAYS_MS);
  assertEquals(nextAttemptAt(7, t0), null);
});

Deno.test("a delivery that keeps failing walks the whole schedule, keeps its event id, and ends 'failed'", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS });
  const d = r.pending("d1");
  r.transport.answer = () => ({ kind: "error", code: "connect_failed" });
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    const report = await r.retry();
    assertEquals(report.leased, 1, `attempt ${attempt} was due`);
    assertEquals(d.attempt, attempt);
    if (attempt < MAX_ATTEMPTS) {
      assertEquals(d.next_attempt_at! - r.now(), RETRY_DELAYS_MS[attempt - 1]);
      // Not due a moment early.
      r.advance(RETRY_DELAYS_MS[attempt - 1] - 1);
      assertEquals((await r.retry()).leased, 0);
      r.advance(1);
    }
  }
  assertEquals([d.status, d.next_attempt_at, d.message_ids], ["failed", null, null]);
  const ids = new Set(r.transport.sent.map((s) => JSON.parse(s.body).id));
  assertEquals(ids.size, 1, "every retry is the same event");
  assertEquals(JSON.parse(r.transport.sent[0].body).message_ids, ["INBOX:7"]);
});

Deno.test("a 2xx on a retry delivers it and resets the endpoint's failure run", async () => {
  const r = rig();
  const ep = r.hooks.endpoint({ id: "ep", workspace_id: WS, consecutive_failures: 4, failing_since: r.now() - HOUR });
  const d = r.pending("d1");
  const report = await r.retry();
  assertEquals(report.delivered, 1);
  assertEquals([d.status, d.attempt, d.message_ids], ["delivered", 2, null]);
  assertEquals([ep.consecutive_failures, ep.failing_since], [0, null]);
});

Deno.test("50 failures in a row disable the endpoint, abandon what is pending, and email the owner once", async () => {
  const r = rig();
  const ep = r.hooks.endpoint({ id: "ep", workspace_id: WS, consecutive_failures: DISABLE_AFTER_FAILURES - 2, failing_since: r.now() - MIN });
  r.pending("d1");
  r.pending("d2");
  const later = r.pending("d3", { next_attempt_at: r.now() + HOUR });
  r.transport.answer = () => ({ kind: "response", status: 500 });
  const report = await r.retry();
  assertEquals(ep.disabled_reason, "failing");
  assert(ep.disabled_at !== null);
  assertEquals(report.disabled, 1);
  assertEquals(r.disabled, ["ep"], "one email, not one per failed delivery");
  assertEquals([later.status, later.error_code, later.message_ids], ["abandoned", "endpoint_disabled", null]);
});

Deno.test("24 hours of failure disable the endpoint even below 50 failures", async () => {
  const r = rig();
  const ep = r.hooks.endpoint({ id: "ep", workspace_id: WS, consecutive_failures: 6, failing_since: r.now() - 24 * HOUR });
  r.pending("d1");
  r.transport.answer = () => ({ kind: "error", code: "timeout" });
  await r.retry();
  assertEquals(ep.disabled_reason, "failing");
  assertEquals(r.disabled, ["ep"]);
  assert(r.logs.includes("webhook_endpoint_disabled"));
});

Deno.test("a paused workspace's retries are abandoned without a POST; the endpoint is kept", async () => {
  const r = rig();
  const ep = r.hooks.endpoint({ id: "ep", workspace_id: WS });
  const d = r.pending("d1");
  r.hooks.allowed.delete(WS);
  const report = await r.retry();
  assertEquals(report.abandoned, 1);
  assertEquals([d.status, d.error_code, d.message_ids], ["abandoned", "paused", null]);
  assertEquals(r.transport.sent.length, 0);
  assertEquals(ep.disabled_at, null);
});

Deno.test("a manually disabled endpoint's retries are abandoned", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS, disabled_at: new Date().toISOString(), disabled_reason: "manual" });
  const d = r.pending("d1");
  await r.retry();
  assertEquals([d.status, d.error_code], ["abandoned", "endpoint_disabled"]);
  assertEquals(r.transport.sent.length, 0);
});

Deno.test("a headers-mode retry reads sender and subject again for the stored ids; a missing one is null", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS, payload_mode: "headers" });
  r.pending("d1", { message_ids: ["INBOX:7", "INBOX:6"], message_count: 2 });
  r.mail.rows.set(INBOX, [{ id: "INBOX:7", from: "Ola", subject: "Hei", unread: true }]);
  await r.retry();
  assertEquals(JSON.parse(r.transport.sent[0].body).messages, [
    { id: "INBOX:7", from: "Ola", subject: "Hei" },
    { id: "INBOX:6", from: null, subject: null },
  ]);
});

Deno.test("no retry starts after the deadline", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS });
  r.pending("d1");
  const report = await runSends(r.deps, r.mail, { deadlineMs: r.now(), limits: LIMITS });
  assertEquals(report.leased, 0);
  assertEquals(r.transport.sent.length, 0);
});

Deno.test("retries are sent from the per-minute dispatch pass even when no mailbox is due", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS });
  const d = r.pending("d1");
  const deps: DispatchDeps = {
    store: fakePushStore(r.now, WS),
    mail: r.mail,
    sender: fakeSender(),
    webhooks: r.deps,
    now: r.now,
  };
  const summary = await runDispatch(deps);
  assertEquals([summary.leased, summary.webhook_attempts, summary.webhooks_delivered], [0, 1, 1]);
  assertEquals(d.status, "delivered");
});

Deno.test("a headers retry does not read a mailbox whose watch is backing off: ids only, flagged", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS, payload_mode: "headers" });
  r.hooks.inboxes.set(INBOX, { workspace_id: WS, provider: "imap", mail_host: "imap.h.example", backoff_until: new Date(r.now() + HOUR).toISOString() });
  r.pending("d1");
  await r.retry();
  const event = JSON.parse(r.transport.sent[0].body);
  assertEquals(event.headers_omitted, true);
  assertEquals(event.messages, undefined);
  assertEquals(event.message_ids, ["INBOX:7"]);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 0);
});

Deno.test("a headers retry does not read a mailbox whose login was just refused", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS, payload_mode: "headers" });
  r.hooks.inboxes.set(INBOX, { workspace_id: WS, provider: "imap", mail_host: "imap.h.example", last_error: loginRefusedMarker(r.now() - MIN) });
  r.pending("d1");
  await r.retry();
  assertEquals(JSON.parse(r.transport.sent[0].body).headers_omitted, true);
  assertEquals(r.mail.calls.filter((c) => c.op === "newest").length, 0);
});

Deno.test("headers reads in the send step respect the per-host cap", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS, payload_mode: "headers" });
  let inFlight = 0;
  let maxInFlight = 0;
  const slowMail: WatchMail = {
    probe: () => Promise.reject(new Error("unused")),
    gmailAdded: () => Promise.resolve(null),
    async newest() {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return [] as NewestRow[];
    },
    close: () => Promise.resolve(),
  };
  for (let n = 1; n <= 4; n++) {
    const inbox = `22222222-2222-4222-8222-00000000010${n}`;
    r.hooks.inboxes.set(inbox, { workspace_id: WS, provider: "imap", mail_host: "imap.same-host.example" });
    r.pending(`d${n}`, { inbox_id: inbox });
  }
  await runSends(r.deps, slowMail, { deadlineMs: r.now() + 40_000, limits: LIMITS });
  assertEquals(r.transport.sent.length, 4);
  assert(maxInFlight <= HOST_CONCURRENCY, `max ${maxInFlight} reads on one host`);
});

Deno.test("first attempts are sent before retries", async () => {
  const r = rig();
  r.hooks.endpoint({ id: "ep", workspace_id: WS });
  r.pending("d1", { attempt: 3, next_attempt_at: r.now() - HOUR });
  r.pending("d2", { attempt: 0, next_attempt_at: r.now() });
  await r.retry();
  assertEquals(r.transport.sent.map((s) => JSON.parse(s.body).id), [`evt_${"a".repeat(31)}2`, `evt_${"a".repeat(31)}1`]);
});
