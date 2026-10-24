// deno-lint-ignore-file no-explicit-any
// Unit tests for subscription-cleanup.ts: the scan and cleanup handlers and
// the follow-up, with every dependency injected (an in-memory store, fake
// provider calls). Addresses are example.com only.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ListHeaderRecord } from "./list-unsubscribe.ts";
import type { OneClickResult } from "./one-click-post.ts";
import {
  type ClaimRequestResult,
  type FollowUpRow,
  type NewPlanRow,
  type NewRequestRow,
  type PlanRow,
  type RequestUpdate,
  runSubscriptionFollowUp,
  runSubscriptionsCleanup,
  runSubscriptionsScan,
  type SubCaller,
  SUBSCRIPTION_TOOL_DEFINITIONS,
  type SubscriptionDeps,
  type SubscriptionStore,
  supabaseSubscriptionStore,
} from "./subscription-cleanup.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const WS = "11111111-1111-4111-8111-111111111111";
const INBOX = { id: "22222222-2222-4222-8222-222222222222", email_address: "me@example.com", provider: "imap" };
const T0 = Date.parse("2026-10-24T12:00:00Z");

const CALLER: SubCaller = {
  id: "33333333-3333-4333-8333-333333333333",
  workspace_id: WS,
  inbox_ids: null,
  scopes: ["read:email", "manage:folders", "manage:drafts"],
};

// A DKIM signature over both list headers from example.com, and a passing,
// aligned Authentication-Results: enough for list-unsubscribe.ts to call a
// sender safe and one-click.
function signed(domain: string): Pick<ListHeaderRecord, "dkimSignatures" | "authResults"> {
  return {
    dkimSignatures: [`v=1; a=rsa-sha256; d=${domain}; s=s1; h=from:list-unsubscribe:list-unsubscribe-post; b=x`],
    authResults: [`mx.example.com; dkim=pass header.d=${domain}`],
  };
}

let seq = 0;
function rec(over: Partial<ListHeaderRecord>): ListHeaderRecord {
  seq++;
  return {
    messageId: `INBOX:${seq}`,
    folder: "INBOX",
    fromAddress: "news@example.com",
    fromName: "Example News",
    listId: null,
    listUnsubscribe: null,
    listUnsubscribePost: null,
    seen: false,
    receivedAt: new Date(T0 - seq * 3600_000).toISOString(),
    inJunk: false,
    ...signed("example.com"),
    ...over,
  };
}

function records(): ListHeaderRecord[] {
  const out: ListHeaderRecord[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(rec({
      fromAddress: "news@example.com",
      fromName: "Example News",
      listId: "<news.example.com>",
      listUnsubscribe: "<https://unsub.example.com/u?t=secret1>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    }));
  }
  for (let i = 0; i < 3; i++) {
    out.push(rec({
      fromAddress: "deals@shop.example.com",
      fromName: "Shop Deals",
      ...signed("shop.example.com"),
      listUnsubscribe: "<mailto:leave@shop.example.com?subject=remove%20me>",
    }));
  }
  out.push(rec({
    fromAddress: "digest@blog.example.com",
    fromName: "Blog Digest",
    ...signed("blog.example.com"),
    listUnsubscribe: "<https://blog.example.com/unsubscribe?t=secret2>",
  }));
  out.push(rec({
    fromAddress: "spam@junk.example.com",
    fromName: "Junk Sender",
    ...signed("junk.example.com"),
    listUnsubscribe: "<https://junk.example.com/u>",
    listUnsubscribePost: "List-Unsubscribe=One-Click",
    inJunk: true,
    folder: "Junk",
    messageId: "Junk:1",
  }));
  return out;
}

class MemoryStore implements SubscriptionStore {
  plans = new Map<string, PlanRow & { workspace_id: string }>();
  requests = new Map<string, Record<string, unknown>>();
  private n = 0;
  constructor(private clock: () => number) {}
  private id() {
    this.n++;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.n).padStart(12, "0")}`;
  }
  insertPlan(row: NewPlanRow): Promise<string | null> {
    const id = this.id();
    this.plans.set(id, {
      id,
      workspace_id: row.workspace_id,
      inbox_id: row.inbox_id,
      senders: row.senders,
      senders_encrypted: true,
      window_days: row.window_days,
      scanned: row.scanned,
      truncated: row.truncated,
      created_at: new Date(this.clock()).toISOString(),
      expires_at: row.expires_at,
      used_at: null,
      progress: null,
      backlog_action: null,
      backlog_moved: 0,
      backlog_remaining: 0,
      backlog_leased_until: null,
    });
    return Promise.resolve(id);
  }
  loadPlan(planId: string, workspaceId: string) {
    const row = this.plans.get(planId);
    return Promise.resolve(row && row.workspace_id === workspaceId ? { ...row } : null);
  }
  claimPlan(input: { planId: string; workspaceId: string; nowIso: string; backlogAction: "archive" | "keep"; leaseUntilIso: string }) {
    const row = this.plans.get(input.planId);
    if (!row || row.workspace_id !== input.workspaceId || row.used_at) return Promise.resolve(false);
    row.used_at = input.nowIso;
    row.backlog_action = input.backlogAction;
    row.backlog_leased_until = input.leaseUntilIso;
    return Promise.resolve(true);
  }
  saveProgress(
    planId: string,
    update: { progress: { v: 1; data: string }; backlog_moved: number; backlog_remaining: number },
    releaseLease = true,
  ) {
    const row = this.plans.get(planId)!;
    row.progress = update.progress;
    row.backlog_moved = update.backlog_moved;
    row.backlog_remaining = update.backlog_remaining;
    if (releaseLease) row.backlog_leased_until = null;
    this.progressWrites.push(JSON.parse(update.progress.data.slice(4)));
    return Promise.resolve();
  }
  progressWrites: any[] = [];
  reclaimPlan(input: { planId: string; workspaceId: string; previousUsedAtIso: string; nowIso: string; leaseUntilIso: string }) {
    const row = this.plans.get(input.planId);
    if (!row || row.workspace_id !== input.workspaceId || row.used_at !== input.previousUsedAtIso) {
      return Promise.resolve(false);
    }
    row.used_at = input.nowIso;
    row.backlog_leased_until = input.leaseUntilIso;
    return Promise.resolve(true);
  }
  leaseBacklog(planId: string, nowIso: string, untilIso: string) {
    const row = this.plans.get(planId)!;
    if (row.backlog_leased_until && row.backlog_leased_until > nowIso) return Promise.resolve(false);
    row.backlog_leased_until = untilIso;
    return Promise.resolve(true);
  }
  /** Set to make every ledger insert fail. */
  failClaims = false;
  /** Set to make every finishRequest write fail. */
  failFinishes = false;
  claimRequest(row: NewRequestRow, staleBeforeIso: string): Promise<ClaimRequestResult> {
    if (this.failClaims) return Promise.resolve({ claimed: false, write_failed: true });
    const existing = [...this.requests.values()].find((r) => r.idempotency_key === row.idempotency_key);
    if (!existing) {
      const id = this.id();
      this.requests.set(id, { ...row, id, status: "pending", draft_id: null, checked_at: null, check_attempts: 0 });
      return Promise.resolve({ claimed: true, id });
    }
    const stalePending = existing.status === "pending" && (existing.claimed_at as string) < staleBeforeIso;
    if (stalePending || ["failed", "needs_user", "skipped_unsafe"].includes(existing.status as string)) {
      existing.status = "pending";
      existing.claimed_at = row.claimed_at;
      return Promise.resolve({ claimed: true, id: existing.id as string });
    }
    return Promise.resolve({
      claimed: false,
      status: existing.status as string,
      draft_id: (existing.draft_id as string | null) ?? null,
    });
  }
  finishRequest(id: string, update: RequestUpdate) {
    if (this.failFinishes) return Promise.resolve(false);
    Object.assign(this.requests.get(id)!, update);
    return Promise.resolve(true);
  }
  listDueFollowUps(nowIso: string, limit: number): Promise<FollowUpRow[]> {
    return Promise.resolve(
      [...this.requests.values()]
        .filter((r) =>
          r.checked_at === null && typeof r.check_after === "string" && (r.check_after as string) <= nowIso &&
          ["requested", "draft_ready"].includes(r.status as string)
        )
        .slice(0, limit)
        .map((r) => ({
          id: r.id as string,
          inbox_id: r.inbox_id as string,
          from_address: r.from_address as string | null,
          status: r.status as string,
          requested_at: r.requested_at as string | null,
          check_after: r.check_after as string | null,
          check_attempts: (r.check_attempts as number | undefined) ?? 0,
        })),
    );
  }
  claimFollowUp(id: string) {
    const r = this.requests.get(id)!;
    if (r.check_leased_at) return Promise.resolve(false);
    r.check_leased_at = "x";
    return Promise.resolve(true);
  }
  finishFollowUp(id: string, update: { status: string | null; checked_at: string; error?: string | null }) {
    const r = this.requests.get(id)!;
    if (update.status) r.status = update.status;
    if (update.error) r.error = update.error;
    r.checked_at = update.checked_at;
    r.check_leased_at = null;
    return Promise.resolve();
  }
  releaseFollowUp(id: string) {
    this.requests.get(id)!.check_leased_at = null;
    return Promise.resolve();
  }
  deferFollowUp(id: string, update: { check_after: string; check_attempts: number }) {
    const r = this.requests.get(id)!;
    if (r.checked_at !== null) return Promise.resolve();
    Object.assign(r, update, { check_leased_at: null });
    return Promise.resolve();
  }
}

interface Harness {
  deps: SubscriptionDeps;
  store: MemoryStore;
  posts: string[];
  drafts: { to: string; subject: string; body: string }[];
  archived: string[][];
  setNow(ms: number): void;
  enabled: { value: boolean };
}

function harness(opts: {
  records?: ListHeaderRecord[] | (() => ListHeaderRecord[]);
  post?: (url: string) => OneClickResult;
  archiveBatch?: number;
} = {}): Harness {
  let now = T0;
  const store = new MemoryStore(() => now);
  const posts: string[] = [];
  const drafts: { to: string; subject: string; body: string }[] = [];
  const archived: string[][] = [];
  const enabled = { value: true };
  const deps: SubscriptionDeps = {
    store,
    encrypt: (s) => Promise.resolve(`enc:${s}`),
    decrypt: (s) => Promise.resolve(s.slice(4)),
    digest: (s) => Promise.resolve(`d:${s}`),
    appUrl: "https://app.example.com",
    now: () => now,
    workspaceEnabled: () => Promise.resolve(enabled.value),
    resolveInbox: () => Promise.resolve({ ok: true, inbox: INBOX }),
    scan: () =>
      Promise.resolve({
        records: typeof opts.records === "function" ? opts.records() : opts.records ?? records(),
        scanned: 9,
        truncated: false,
        // The fixtures' Authentication-Results are written by mx.example.com.
        trust: { ids: ["mx.example.com"] },
      }),
    postOneClick: (url) => {
      posts.push(url);
      return Promise.resolve(opts.post ? opts.post(url) : { ok: true, status: 200, durationMs: 5 });
    },
    createDraft: (_inbox, draft) => {
      drafts.push(draft);
      return Promise.resolve({ ok: true, draft_id: `draft-${drafts.length}` });
    },
    archive: (_inbox, ids) => {
      const batch = ids.slice(0, opts.archiveBatch ?? ids.length);
      archived.push(batch);
      return Promise.resolve({ destination: "Archive", moved: batch, failed: [] });
    },
  };
  return { deps, store, posts, drafts, archived, setNow: (ms) => (now = ms), enabled };
}

async function scanPlan(h: Harness) {
  const out = await runSubscriptionsScan(h.deps, CALLER, {});
  assertEquals(out.result.isError, false);
  const subs = out.result.structuredContent!.subscriptions as Record<string, any>;
  return { out, subs, planId: subs.plan_id as string };
}

// ── Scan ────────────────────────────────────────────────────────────────────

Deno.test("scan: stores an encrypted plan and returns the pending card envelope with no URLs", async () => {
  const h = harness();
  const { out, subs } = await scanPlan(h);
  const env = out.result.structuredContent!;
  assertEquals(env.card, "subscription_plan");
  assertEquals(env.state, "pending");
  assertEquals(env.schema_version, "review-card-v1");
  // The Junk sender keeps its method (link: one-click needs a safe sender) and counts as unsafe.
  assertEquals(subs.summary, { senders: 4, one_click: 1, mailto: 1, link: 2, none: 0, unsafe: 1 });
  const keys = subs.senders.map((s: any) => s.sender_key);
  assert(keys.includes("list:news.example.com"));
  const news = subs.senders.find((s: any) => s.sender_key === "list:news.example.com");
  assertEquals(news.method, "one_click");
  assertEquals(news.url_host, "unsub.example.com");
  const junk = subs.senders.find((s: any) => s.sender_key === "from:spam@junk.example.com");
  assertEquals(junk.safe, false);
  assertEquals(junk.unsafe_reason, "in_junk");
  // Nothing secret leaves the server: no URL path, no message id.
  const wire = JSON.stringify(out.result);
  assert(!wire.includes("secret1") && !wire.includes("secret2"), "no unsubscribe token in the result");
  assert(!wire.includes("INBOX:"), "no message id in the result");
  // The stored plan is ciphertext.
  const stored = [...h.store.plans.values()][0];
  assert(String((stored.senders as any).data).startsWith("enc:"));
  assertEquals(out.logDetails?.phase, "subscription_scan");
  assertEquals((out.logDetails as any).one_click, 1);
  assertEquals((out.logDetails as any).mailto, 1);
  assert(out.result.content[0].text.includes("plan_id: "));
  assert(out.result.content[0].text.includes("nothing is sent"));
});

Deno.test("scan: refused with isError when the workspace flag is off", async () => {
  const h = harness();
  h.enabled.value = false;
  const out = await runSubscriptionsScan(h.deps, CALLER, {});
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "feature_not_enabled");
  assertEquals(h.store.plans.size, 0);
});

Deno.test("scan: a provider failure is an isError result, not a throw", async () => {
  const h = harness();
  h.deps.scan = () => Promise.reject(new Error("imap_auth_failed"));
  const out = await runSubscriptionsScan(h.deps, CALLER, {});
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "imap_auth_failed");
});

// ── Cleanup: the ladder ─────────────────────────────────────────────────────

Deno.test("cleanup: runs the ladder per method and never sends mail", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: [
      "list:news.example.com",
      "from:deals@shop.example.com",
      "from:digest@blog.example.com",
      "from:spam@junk.example.com",
    ],
    backlog: "keep",
  });
  assertEquals(out.result.isError, false);
  const env = out.result.structuredContent!;
  assertEquals(env.state, "executed");
  const results = (env.subscriptions as any).results as any[];
  const by = Object.fromEntries(results.map((r) => [r.sender_key, r]));
  assertEquals(by["list:news.example.com"].status, "requested");
  assertEquals(by["from:deals@shop.example.com"].status, "draft_ready");
  assertEquals(by["from:deals@shop.example.com"].draft_id, "draft-1");
  assertEquals(by["from:digest@blog.example.com"].status, "needs_user");
  assertEquals(by["from:digest@blog.example.com"].link, "https://blog.example.com/unsubscribe?t=secret2");
  assertEquals(by["from:spam@junk.example.com"].status, "skipped_unsafe");
  for (const r of results) {
    assert(r.display_name, "every result carries display_name");
    if (r.status !== "needs_user") assertEquals(r.link, null);
  }
  // One POST, to the one-click sender only (never the junk one).
  assertEquals(h.posts, ["https://unsub.example.com/u?t=secret1"]);
  assertEquals(h.drafts, [{ to: "leave@shop.example.com", subject: "remove me", body: "unsubscribe" }]);
  // Ledger rows: one per sender; follow-up scheduled 72 h out for requested and draft_ready.
  const rows = [...h.store.requests.values()];
  assertEquals(rows.length, 4);
  const requested = rows.find((r) => r.sender_key === "list:news.example.com")!;
  assertEquals(requested.check_after, new Date(T0 + 72 * 3600_000).toISOString());
  assertEquals(requested.http_status, 200);
  const link = rows.find((r) => r.sender_key === "from:digest@blog.example.com")!;
  assertEquals(link.check_after, undefined);
  // No URL in the ledger, host only.
  // (idempotency_key is an HMAC in production; the test digest is plain text.)
  assert(!JSON.stringify(rows.map(({ idempotency_key: _k, ...rest }) => rest)).includes("secret"));
  assertEquals((out.logDetails as any).one_click_hosts, ["https://unsub.example.com"]);
  assertEquals(env.actor, { can_decide: false, reason: "not_pending" });
});

Deno.test("cleanup: a failing POST is failed, a redirect is not followed", async () => {
  const h = harness({ post: () => ({ ok: false, status: 302, error: "redirect", durationMs: 3 }) });
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  const r = (out.result.structuredContent!.subscriptions as any).results[0];
  assertEquals(r.status, "failed");
  assertEquals(r.link, null);
  const row = [...h.store.requests.values()][0];
  assertEquals(row.error, "redirect");
  assertEquals(row.check_after, undefined);
});

Deno.test("cleanup: a key without manage:drafts gets the address to email, never a mailto link", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(
    h.deps,
    { ...CALLER, scopes: ["read:email", "manage:folders"] },
    { plan_id: planId, sender_keys: ["from:deals@shop.example.com"] },
  );
  const r = (out.result.structuredContent!.subscriptions as any).results[0];
  assertEquals(r.status, "needs_user");
  // The card opens https links only: a mailto URI there would be a dead end.
  assertEquals(r.link, null);
  assertEquals(r.mailto_address, "leave@shop.example.com");
  assert(r.detail.includes("email leave@shop.example.com with the word unsubscribe"));
  assert(out.result.content[0].text.includes("leave@shop.example.com"));
  assertEquals(h.drafts.length, 0);
});

// ── Cleanup: guards ─────────────────────────────────────────────────────────

Deno.test("cleanup: rejects a sender key that is not in the plan, before anything runs", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: ["list:news.example.com", "from:attacker@example.com"],
  });
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "unknown_sender_keys");
  assertEquals(h.posts.length, 0);
  assertEquals(h.store.requests.size, 0);
  // The plan was not consumed.
  assertEquals([...h.store.plans.values()][0].used_at, null);
});

Deno.test("cleanup: an expired plan is refused with state expired", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  h.setNow(T0 + 61 * 60_000);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  assertEquals(out.result.isError, true);
  assertEquals(out.result.structuredContent!.state, "expired");
  assertEquals(h.posts.length, 0);
});

Deno.test("cleanup: another workspace, or an inbox outside the key's allowlist, cannot see the plan", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const foreign = await runSubscriptionsCleanup(
    h.deps,
    { ...CALLER, workspace_id: "99999999-9999-4999-8999-999999999999" },
    { plan_id: planId, sender_keys: ["list:news.example.com"] },
  );
  assertEquals(foreign.logErrorCode, "plan_not_found");
  const narrowed = await runSubscriptionsCleanup(
    h.deps,
    { ...CALLER, inbox_ids: ["44444444-4444-4444-8444-444444444444"] },
    { plan_id: planId, sender_keys: ["list:news.example.com"] },
  );
  assertEquals(narrowed.logErrorCode, "plan_not_found");
  assertEquals(h.posts.length, 0);
});

Deno.test("cleanup: refused when the workspace flag is off", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  h.enabled.value = false;
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "feature_not_enabled");
  assertEquals(h.posts.length, 0);
});

Deno.test("cleanup: invalid arguments are refused", async () => {
  const h = harness();
  for (const args of [{}, { plan_id: "nope", sender_keys: [] }, { plan_id: WS, sender_keys: "x" }, {
    plan_id: WS,
    sender_keys: [],
  }, { plan_id: WS, sender_keys: ["a"], backlog: "folder" }]) {
    const out = await runSubscriptionsCleanup(h.deps, CALLER, args);
    assertEquals(out.result.isError, true, JSON.stringify(args));
  }
});

// ── Idempotency ─────────────────────────────────────────────────────────────

Deno.test("cleanup: a replayed call and a second plan never POST twice", async () => {
  const h = harness();
  const first = await scanPlan(h);
  const args = { plan_id: first.planId, sender_keys: ["list:news.example.com"], backlog: "keep" };
  await runSubscriptionsCleanup(h.deps, CALLER, args);
  assertEquals(h.posts.length, 1);

  // Same plan again: replayed from the stored results, nothing re-run.
  const replay = await runSubscriptionsCleanup(h.deps, CALLER, args);
  assertEquals(replay.result.isError, false);
  assertEquals((replay.result.structuredContent!.subscriptions as any).results[0].status, "requested");
  assertEquals(h.posts.length, 1);

  // A fresh scan, the same sender: the ledger answers already_done.
  const second = await scanPlan(h);
  const again = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: second.planId,
    sender_keys: ["list:news.example.com"],
  });
  const r = (again.result.structuredContent!.subscriptions as any).results[0];
  assertEquals(r.status, "already_done");
  assertEquals(h.posts.length, 1);
  assertEquals(h.store.requests.size, 1);
});

Deno.test("cleanup: a failed attempt may be retried from a new plan", async () => {
  let fail = true;
  const h = harness({
    post: () => fail ? { ok: false, status: 500, error: "http_error", durationMs: 1 } : { ok: true, status: 202, durationMs: 1 },
  });
  const first = await scanPlan(h);
  await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: first.planId, sender_keys: ["list:news.example.com"] });
  fail = false;
  const second = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: second.planId,
    sender_keys: ["list:news.example.com"],
  });
  assertEquals((out.result.structuredContent!.subscriptions as any).results[0].status, "requested");
  assertEquals(h.posts.length, 2);
});

Deno.test("cleanup: a second scan with a new per-message token returns already_done without a POST", async () => {
  let token = "secret1";
  const h = harness({
    records: () =>
      records().map((r) =>
        r.listUnsubscribe?.includes("unsub.example.com") ? { ...r, listUnsubscribe: `<https://unsub.example.com/u?t=${token}>` } : r
      ),
  });
  const first = await scanPlan(h);
  await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: first.planId, sender_keys: ["list:news.example.com"] });
  assertEquals(h.posts, ["https://unsub.example.com/u?t=secret1"]);
  token = "fresh-token-2";
  const second = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: second.planId,
    sender_keys: ["list:news.example.com", "from:deals@shop.example.com"],
  });
  const results = (out.result.structuredContent!.subscriptions as any).results;
  assertEquals(results[0].status, "already_done");
  assertEquals(h.posts.length, 1);
  // mailto is keyed by the address: a third scan does not draft twice either.
  const third = await scanPlan(h);
  const again = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: third.planId,
    sender_keys: ["from:deals@shop.example.com"],
  });
  assertEquals((again.result.structuredContent!.subscriptions as any).results[0].status, "already_done");
  assertEquals(h.drafts.length, 1);
});

Deno.test("cleanup: an unverifiable sender is never POSTed to; its link comes back instead", async () => {
  const h = harness({
    records: () =>
      records().map((r) =>
        r.fromAddress === "news@example.com"
          ? { ...r, authResults: ["mx.example.net; dkim=pass header.d=example.com"] } // not a trusted authserv-id
          : r
      ),
  });
  const { subs, planId } = await scanPlan(h);
  const news = subs.senders.find((s: any) => s.sender_key === "list:news.example.com");
  assertEquals(news.safe, false);
  assertEquals(news.unsafe_reason, "auth_unverified");
  assertEquals(news.method, "link");
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  const r = (out.result.structuredContent!.subscriptions as any).results[0];
  assertEquals(r.status, "needs_user");
  assertEquals(r.link, "https://unsub.example.com/u?t=secret1");
  assertEquals(h.posts.length, 0);
});

// ── Crash recovery ──────────────────────────────────────────────────────────

Deno.test("cleanup: progress is saved before the one-click POSTs start", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  let seenAtPost: any = null;
  h.deps.postOneClick = (url) => {
    seenAtPost = h.store.progressWrites.at(-1);
    h.posts.push(url);
    return Promise.resolve({ ok: true, status: 200, durationMs: 1 });
  };
  await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: ["list:news.example.com", "from:deals@shop.example.com"],
  });
  assertEquals(seenAtPost.complete, false);
  assertEquals(seenAtPost.selected, ["list:news.example.com", "from:deals@shop.example.com"]);
  assertEquals(seenAtPost.results.map((r: any) => r.status), ["draft_ready"]);
  assertEquals(h.store.progressWrites.at(-1).complete, true);
});

Deno.test("cleanup: a run killed mid-POST is in progress, then recoverable after the lease", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  h.deps.postOneClick = () => Promise.reject(new Error("isolate killed"));
  const args = { plan_id: planId, sender_keys: ["list:news.example.com", "from:deals@shop.example.com"], backlog: "keep" };
  // A throw is caught (a tool error, not an unhandled -32603); the ledger row stays pending.
  const killed = await runSubscriptionsCleanup(h.deps, CALLER, args);
  assertEquals(killed.result.isError, true);
  assertEquals(killed.logErrorCode, "subscription_internal_error");
  const news = [...h.store.requests.values()].find((r) => r.sender_key === "list:news.example.com")!;
  assertEquals(news.status, "pending");

  // Inside the lease: in progress, nothing re-run.
  h.setNow(T0 + 5 * 60_000);
  const early = await runSubscriptionsCleanup(h.deps, CALLER, args);
  assertEquals(early.logErrorCode, "plan_in_progress");

  // A second scan inside the lease does not POST either: the pending row holds.
  h.deps.postOneClick = (url) => {
    h.posts.push(url);
    return Promise.resolve({ ok: true, status: 200, durationMs: 1 });
  };
  const other = await scanPlan(h);
  const blocked = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: other.planId, sender_keys: ["list:news.example.com"] });
  assertEquals((blocked.result.structuredContent!.subscriptions as any).results[0].status, "already_done");
  assertEquals(h.posts.length, 0);

  // After the lease the replay (here, the card's continue call) recovers.
  h.setNow(T0 + 12 * 60_000);
  const late = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: [], backlog: "keep", continue: true });
  assertEquals(late.result.isError, false);
  const results = (late.result.structuredContent!.subscriptions as any).results;
  assertEquals(results.map((r: any) => [r.sender_key, r.status]), [
    ["list:news.example.com", "requested"],
    ["from:deals@shop.example.com", "draft_ready"],
  ]);
  assertEquals(h.posts.length, 1);
  // The draft from the dead run stands; it is not made twice.
  assertEquals(h.drafts.length, 1);
  assertEquals(news.status, "requested");
  // And it is complete now: a replay just replays.
  const replay = await runSubscriptionsCleanup(h.deps, CALLER, args);
  assertEquals(replay.result.isError, false);
  assertEquals(h.posts.length, 1);
});

Deno.test("cleanup: a lost ledger write leaves the row retryable after the lease, never pending forever", async () => {
  const h = harness();
  const first = await scanPlan(h);
  h.store.failFinishes = true;
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: first.planId, sender_keys: ["list:news.example.com"] });
  assertEquals((out.result.structuredContent!.subscriptions as any).results[0].status, "requested");
  assertEquals([...h.store.requests.values()][0].status, "pending");
  h.store.failFinishes = false;
  h.setNow(T0 + 11 * 60_000);
  const second = await scanPlan(h);
  const retry = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: second.planId, sender_keys: ["list:news.example.com"] });
  assertEquals((retry.result.structuredContent!.subscriptions as any).results[0].status, "requested");
  assertEquals(h.posts.length, 2);
  assertEquals([...h.store.requests.values()][0].status, "requested");
});

// ── Column limits ───────────────────────────────────────────────────────────

Deno.test("cleanup: over-long header values are cut to the ledger's limits, and a long List-Id still cleans", async () => {
  const longLocal = "a".repeat(330);
  const longList = `${"l".repeat(700)}.example.com`;
  const h = harness({
    records: [0, 1, 2].map(() =>
      rec({
        fromAddress: `${longLocal}@example.com`,
        fromName: "N".repeat(400),
        listId: `<${longList}>`,
        listUnsubscribe: "<https://unsub.example.com/u?t=x>",
        listUnsubscribePost: "List-Unsubscribe=One-Click",
      })
    ),
  });
  const { subs, planId } = await scanPlan(h);
  assertEquals(subs.senders.length, 1);
  const key = subs.senders[0].sender_key as string;
  assert(key.length <= 600, "the key fits the ledger and the tool's argument limit");
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: [key] });
  assertEquals((out.result.structuredContent!.subscriptions as any).results[0].status, "requested");
  const row = [...h.store.requests.values()][0];
  assert((row.sender_key as string).length <= 600);
  assert((row.from_address as string).length <= 320);
  assert((row.display_name as string).length <= 200);
  assert(((row.sender_domain as string) ?? "").length <= 255);
});

Deno.test("cleanup: a ledger insert that fails is reported as failed and sends nothing", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  h.store.failClaims = true;
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  const r = (out.result.structuredContent!.subscriptions as any).results[0];
  assertEquals(r.status, "failed");
  assert(r.detail.includes("could not record the request"));
  assertEquals(h.posts.length, 0);
});

// ── Backlog ─────────────────────────────────────────────────────────────────

Deno.test("cleanup: backlog archive moves the senders' mail outside Junk and resumes with continue", async () => {
  const h = harness({ archiveBatch: 2 });
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: ["list:news.example.com", "from:spam@junk.example.com"],
    backlog: "archive",
  });
  const backlog = (out.result.structuredContent!.subscriptions as any).backlog;
  assertEquals(backlog, { action: "archive", destination: "Archive", moved: 2, remaining: 2, has_more: true });
  assertEquals(out.result.structuredContent!.actor, { can_decide: true, reason: null });
  // Junk:1 is never archived.
  assert(!h.archived.flat().includes("Junk:1"));

  // The card's continue call: empty sender_keys.
  const next = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: [],
    backlog: "archive",
    continue: true,
  });
  assertEquals(next.result.isError, false);
  const after = (next.result.structuredContent!.subscriptions as any).backlog;
  assertEquals(after, { action: "archive", destination: "Archive", moved: 4, remaining: 0, has_more: false });
  // The unsubscribe part did not run again.
  assertEquals(h.posts.length, 1);
  assertEquals((next.result.structuredContent!.subscriptions as any).results.length, 2);
  assertEquals(new Set(h.archived.flat()).size, 4);
});

Deno.test("cleanup: continue on a plan that has not run is refused", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: [], continue: true });
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "nothing_to_continue");
});

// ── Follow-up ───────────────────────────────────────────────────────────────

Deno.test("follow-up: due rows become stopped or still_sending, searched after the grace period", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: ["list:news.example.com", "from:deals@shop.example.com"],
  });
  const searches: { from: string; since: string }[] = [];
  // Not due yet.
  let summary = await runSubscriptionFollowUp({
    store: h.store,
    now: () => T0 + 71 * 3600_000,
    search: () => Promise.resolve(false),
  });
  assertEquals(summary.due, 0);

  summary = await runSubscriptionFollowUp({
    store: h.store,
    now: () => T0 + 73 * 3600_000,
    search: (_inbox, from, since) => {
      searches.push({ from, since });
      return Promise.resolve(from === "deals@shop.example.com");
    },
  });
  assertEquals(summary, { due: 2, checked: 2, stopped: 1, still_sending: 1, errors: 0, deferred: 0, given_up: 0 });
  assertEquals(searches.every((s) => s.since === new Date(T0 + 24 * 3600_000).toISOString()), true);
  const statuses = Object.fromEntries([...h.store.requests.values()].map((r) => [r.sender_key, r.status]));
  assertEquals(statuses["list:news.example.com"], "stopped");
  assertEquals(statuses["from:deals@shop.example.com"], "still_sending");

  // Checked rows leave the queue.
  summary = await runSubscriptionFollowUp({ store: h.store, now: () => T0 + 80 * 3600_000, search: () => Promise.resolve(true) });
  assertEquals(summary.due, 0);
});

Deno.test("follow-up: a search failure pushes the row back a day, and the rest of the inbox's batch", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: ["list:news.example.com", "from:deals@shop.example.com"],
  });
  let searches = 0;
  const at = T0 + 73 * 3600_000;
  const summary = await runSubscriptionFollowUp({
    store: h.store,
    now: () => at,
    search: () => {
      searches++;
      return Promise.reject(new Error("inbox_unavailable"));
    },
  });
  assertEquals(searches, 1);
  assertEquals(summary.errors, 1);
  assertEquals(summary.deferred, 2);
  for (const row of h.store.requests.values()) {
    if (row.status !== "requested" && row.status !== "draft_ready") continue;
    assertEquals(row.checked_at, null);
    assertEquals(row.check_leased_at, null);
    assertEquals(row.check_after, new Date(at + 24 * 3600_000).toISOString());
    assertEquals(row.check_attempts, 1);
  }
  // Not due again until the day is over: the queue moves on.
  const soon = await runSubscriptionFollowUp({ store: h.store, now: () => at + 3600_000, search: () => Promise.resolve(false) });
  assertEquals(soon.due, 0);
});

Deno.test("follow-up: after three failed searches the row is closed without a verdict", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  let at = T0 + 73 * 3600_000;
  const fail = () => Promise.reject(new Error("inbox_unavailable"));
  const s1 = await runSubscriptionFollowUp({ store: h.store, now: () => at, search: fail });
  at += 25 * 3600_000;
  const s2 = await runSubscriptionFollowUp({ store: h.store, now: () => at, search: fail });
  at += 25 * 3600_000;
  const s3 = await runSubscriptionFollowUp({ store: h.store, now: () => at, search: fail });
  assertEquals([s1.deferred, s2.deferred, s3.deferred, s3.given_up], [1, 1, 0, 1]);
  const row = [...h.store.requests.values()][0];
  assertEquals(row.status, "requested");
  assertEquals(row.error, "follow_up_unavailable");
  assertEquals(row.checked_at, new Date(at).toISOString());
  at += 25 * 3600_000;
  assertEquals((await runSubscriptionFollowUp({ store: h.store, now: () => at, search: fail })).due, 0);
});

Deno.test("follow-up store: the due list skips soft-deleted and disconnected inboxes", async () => {
  const calls: unknown[][] = [];
  const builder: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) =>
          resolve({ data: [{ id: "r1", inbox_id: "i1", from_address: null, status: "requested", requested_at: null, check_after: null, check_attempts: 0, inboxes: { id: "i1" } }], error: null });
      }
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
        return builder;
      };
    },
  });
  const store = supabaseSubscriptionStore({ from: () => builder });
  const rows = await store.listDueFollowUps(new Date(T0).toISOString(), 10);
  assertEquals(rows.length, 1);
  assertEquals("inboxes" in rows[0], false);
  const select = calls.find((c) => c[0] === "select")!;
  assert(String(select[1]).includes("inboxes!inner"));
  assert(calls.some((c) => c[0] === "is" && c[1] === "inboxes.deleted_at" && c[2] === null));
  assert(calls.some((c) => c[0] === "eq" && c[1] === "inboxes.status" && c[2] === "active"));
});

// ── Definitions ─────────────────────────────────────────────────────────────

Deno.test("definitions: strict inputs, loose outputs, honest annotations", () => {
  const [scan, cleanup] = SUBSCRIPTION_TOOL_DEFINITIONS;
  assertEquals(scan.name, "subscriptions_scan");
  assertEquals(cleanup.name, "subscriptions_cleanup");
  for (const d of SUBSCRIPTION_TOOL_DEFINITIONS) {
    assertEquals(d.inputSchema.additionalProperties, false);
    assertEquals(d.outputSchema.additionalProperties, true);
    assertEquals("required" in d.outputSchema, false);
  }
  assertEquals(scan.annotations.readOnlyHint, true);
  assertEquals(cleanup.annotations.readOnlyHint, false);
  assertEquals(cleanup.annotations.openWorldHint, true);
  // The card's continue call sends an empty list: no minItems.
  assertEquals("minItems" in (cleanup.inputSchema.properties as any).sender_keys, false);
  assert(cleanup.description.includes("nothing is ever sent"));
});

// ── 2026-10-24 fixes ────────────────────────────────────────────────────────

Deno.test("scan: a throw after the provider scan is a tool error with a stable code, not an unhandled -32603", async () => {
  const h = harness();
  h.deps.encrypt = () => Promise.reject(new RangeError("Maximum call stack size exceeded"));
  const out = await runSubscriptionsScan(h.deps, CALLER, {});
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "scan_postprocess_failed");
  assertEquals((out.result._meta as any).error_code, "scan_postprocess_failed");
  assert(out.result.content[0].text.includes("Nothing was changed"));
  assertEquals(h.store.plans.size, 0);

  const h2 = harness();
  h2.store.insertPlan = () => Promise.reject(new Error("connection reset"));
  const out2 = await runSubscriptionsScan(h2.deps, CALLER, {});
  assertEquals(out2.logErrorCode, "scan_postprocess_failed");
});

Deno.test("scan and cleanup: any other throw is subscription_internal_error", async () => {
  const h = harness();
  h.deps.workspaceEnabled = () => Promise.reject(new Error("boom"));
  const scan = await runSubscriptionsScan(h.deps, CALLER, {});
  assertEquals(scan.result.isError, true);
  assertEquals(scan.logErrorCode, "subscription_internal_error");
  const cleanup = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: WS, sender_keys: ["list:x"] });
  assertEquals(cleanup.logErrorCode, "subscription_internal_error");
});

Deno.test("plan TTL: 60 minutes, and the text says so", async () => {
  const h = harness();
  const { out, subs, planId } = await scanPlan(h);
  assertEquals(subs.expires_at, new Date(T0 + 60 * 60_000).toISOString());
  assert(out.result.content[0].text.includes("60 minutes after the scan"));
  assert(SUBSCRIPTION_TOOL_DEFINITIONS[0].description.includes("expires after 60 minutes"));
  // Still runnable at 59 minutes.
  h.setNow(T0 + 59 * 60_000);
  const run = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: ["list:news.example.com"] });
  assertEquals(run.result.isError, false);
});

Deno.test("scan text: names every pre-selected sender with its quoted key, and says the card's selection is what runs", async () => {
  const h = harness();
  const { out, subs } = await scanPlan(h);
  const text = out.result.content[0].text;
  const preselected = subs.senders.filter((s: any) => s.suggested).map((s: any) => s.sender_key);
  assertEquals(preselected.sort(), ["from:deals@shop.example.com", "list:news.example.com"]);
  assert(text.includes(`Pre-selected on the card (${preselected.length})`), text);
  for (const key of preselected) assert(text.includes(`- ${JSON.stringify(key)}: `), key);
  // Senders that are not pre-selected are not in that block.
  const block = text.slice(text.indexOf("Pre-selected on the card"), text.indexOf("Whatever is ticked"));
  assert(!block.includes("digest@blog.example.com") && !block.includes("junk.example.com"), block);
  assert(text.includes("Whatever is ticked on the card when the user presses its button is what gets unsubscribed"));
  assert(text.includes("do not say it was left out"));
  // Keys in the sender list are quoted, so each reads as one token.
  assert(text.includes(`- "list:news.example.com": "Example News", 4 message(s)`), text);
});

Deno.test("scan text: says so when nothing is pre-selected", async () => {
  const h = harness({
    records: () => [rec({ fromAddress: "a@example.com", listUnsubscribe: "<https://example.com/u>" })],
  });
  const { out } = await scanPlan(h);
  assert(out.result.content[0].text.includes("Pre-selected on the card: none."));
});

Deno.test("cleanup: an unknown key is refused with the keys it most likely meant and the valid ones", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, {
    plan_id: planId,
    sender_keys: ["news.example.com", "Shop Deals", "digest@blog.example.com", "LIST:NEWS.EXAMPLE.COM", "nobody"],
  });
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "unknown_sender_keys");
  const text = out.result.content[0].text;
  assert(text.includes(`"news.example.com" (did you mean "list:news.example.com"?)`), text);
  assert(text.includes(`"Shop Deals" (did you mean "from:deals@shop.example.com"?)`), text);
  assert(text.includes(`"digest@blog.example.com" (did you mean "from:digest@blog.example.com"?)`), text);
  assert(text.includes(`"LIST:NEWS.EXAMPLE.COM" (did you mean "list:news.example.com"?)`), text);
  assert(text.includes(`"nobody"`) && !text.includes(`"nobody" (did you mean`), text);
  assert(text.includes("The senders pre-selected on the card are: ["), text);
  // A hint, never an alias: nothing ran and the plan is untouched.
  assertEquals(h.posts.length, 0);
  assertEquals(h.store.requests.size, 0);
  assertEquals([...h.store.plans.values()][0].used_at, null);
});

Deno.test("cleanup: an empty sender_keys without continue names the pre-selected keys and runs nothing", async () => {
  const h = harness();
  const { planId } = await scanPlan(h);
  const out = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: planId, sender_keys: [] });
  assertEquals(out.result.isError, true);
  assertEquals(out.logErrorCode, "invalid_arguments");
  const text = out.result.content[0].text;
  assert(text.includes("sender_keys is empty"), text);
  assert(text.includes(`"list:news.example.com"`) && text.includes(`"from:deals@shop.example.com"`), text);
  assert(text.includes("the card runs the cleanup itself"), text);
  assertEquals(h.posts.length, 0);
  assertEquals([...h.store.plans.values()][0].used_at, null);
});

Deno.test("cleanup: a malformed sender_keys says what was wrong and what shape is expected", async () => {
  const h = harness();
  const notList = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: WS, sender_keys: { a: 1 } });
  assertEquals(notList.logErrorCode, "invalid_arguments");
  assert(notList.result.content[0].text.includes("not an object"));
  assert(notList.result.content[0].text.includes(`["list:news.example.com", "from:deals@example.com"]`));
  const badItem = await runSubscriptionsCleanup(h.deps, CALLER, { plan_id: WS, sender_keys: ["list:a", { sender_key: "x" }] });
  assert(badItem.result.content[0].text.includes("sender_keys[1] is an object"), badItem.result.content[0].text);
});

Deno.test("definitions: sender_keys says where keys come from, without loosening the schema", () => {
  const cleanup = SUBSCRIPTION_TOOL_DEFINITIONS[1];
  const keys = (cleanup.inputSchema.properties as any).sender_keys;
  assertEquals(keys.type, "array");
  assertEquals(keys.items, { type: "string" });
  assert(keys.description.includes("copied exactly"));
  assert(cleanup.description.includes("on the card"));
});
