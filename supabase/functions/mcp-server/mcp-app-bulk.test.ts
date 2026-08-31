// ---------------------------------------------------------------------------
// MCP Apps bulk-plan tests.
//
// The properties under test are the ones that make it safe to let a caller we
// assume is hostile press Execute:
//
//   * the frozen scope is the ONLY thing that runs — no argument can widen,
//     narrow, or restate it;
//   * a plan runs at most once, even under a race;
//   * expiry, cross-workspace ids and the inbox allowlist all refuse, and the
//     last two are indistinguishable from "no such plan";
//   * an inbox that has not opted in is never planned for.
//
// The handlers take their database, crypto, compatibility profile and — the
// important one — the provider execution itself as injected dependencies
// (`BulkDeps`), so "what would actually have been deleted" is directly
// observable here rather than inferred. index.ts cannot be imported by a test
// (it calls Deno.serve and builds a service-role client at module load).
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

// The fake PostgREST store below mirrors an untyped query builder; `any` is the
// honest type for its rows.
// deno-lint-ignore-file no-explicit-any

import {
  BULK_PLAN_TTL_MS,
  BULK_TOOL_DEFINITIONS,
  BULK_TOOL_NAMES,
  type BulkCaller,
  type BulkDeps,
  type BulkExecutionRequest,
  bulkProviderBlock,
  createBulkPlan,
  describeScope,
  isBulkToolName,
  isPlanExpired,
  operationForAction,
  runBulkCancel,
  runBulkExecute,
  runBulkTool,
  shouldPlanForMode,
} from "./mcp-app-bulk.ts";

/** U+202E RIGHT-TO-LEFT OVERRIDE — see text-safety.test.ts. */
const RLO = "\u202e";

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// A fake PostgREST-shaped store
//
// Faithful where it matters: `.eq()` filters really are applied to updates, so
// an `.eq("status","pending")` claim that matches nothing really does return
// null — which is exactly the single-use behaviour the production code leans
// on. Inserts mint UUID-shaped ids, because the handlers refuse a plan_id that
// is not a UUID before they ever reach the database.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

interface FakeHooks {
  /** Runs before a write is applied, so a test can simulate a lost race. */
  beforeWrite?: (table: string, op: string, patch: Row) => void;
  /** Forces an error from the named table, to exercise the failure paths. */
  failTable?: string;
}

let idCounter = 0;
function nextUuid(): string {
  idCounter += 1;
  const tail = String(idCounter).padStart(12, "0");
  return `aaaaaaaa-aaaa-4aaa-8aaa-${tail}`;
}

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private single = false;

  constructor(
    private store: Record<string, Row[]>,
    private table: string,
    private hooks: FakeHooks,
  ) {}

  select(_columns?: string): FakeQuery {
    return this;
  }
  insert(row: Row): FakeQuery {
    this.op = "insert";
    this.patch = row;
    return this;
  }
  update(patch: Row): FakeQuery {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  eq(column: string, value: unknown): FakeQuery {
    this.filters.push([column, value]);
    return this;
  }
  maybeSingle(): Promise<{ data: any; error: any }> {
    this.single = true;
    return this.run();
  }
  then<A, B>(
    onFulfilled?: (value: { data: any; error: any }) => A | PromiseLike<A>,
    onRejected?: (reason: unknown) => B | PromiseLike<B>,
  ): Promise<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  private run(): Promise<{ data: any; error: any }> {
    if (this.hooks.failTable === this.table) {
      return Promise.resolve({ data: null, error: { message: "simulated failure" } });
    }
    const rows = this.store[this.table] ?? (this.store[this.table] = []);
    if (this.op !== "select") this.hooks.beforeWrite?.(this.table, this.op, this.patch);

    if (this.op === "insert") {
      const row = { id: nextUuid(), ...this.patch };
      rows.push(row);
      return Promise.resolve({ data: this.single ? row : [row], error: null });
    }

    const matched = rows.filter((row) =>
      this.filters.every(([column, value]) => row[column] === value)
    );
    if (this.op === "update") {
      for (const row of matched) Object.assign(row, this.patch);
    }
    return Promise.resolve({
      data: this.single ? (matched[0] ?? null) : matched,
      error: null,
    });
  }
}

function fakeDb(store: Record<string, Row[]>, hooks: FakeHooks = {}) {
  return { from: (table: string) => new FakeQuery(store, table, hooks) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const INBOX = "55555555-5555-4555-8555-555555555555";
const OTHER_INBOX = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";
const MISSING_PLAN = "99999999-9999-4999-8999-999999999999";

const CIPHER_PREFIX = "cipher:";
const APP_URL = "https://mcpemails.com";

/** The exact set a plan freezes. Nothing else may ever be acted on. */
const FROZEN_IDS = ["msg-a", "msg-b", "msg-c"];

const caller: BulkCaller = {
  id: KEY,
  workspace_id: WORKSPACE,
  name: "Claude",
  inbox_ids: null,
};

const GMAIL_FACTS = {
  operations: {
    "search.body": "different" as const,
    "search.has_attachment": "exact" as const,
    "search.flagged": "exact" as const,
    "organization.containers": "different" as const,
    "organization.move": "different" as const,
    "organization.copy": "unavailable" as const,
    "delete.permanent": "unavailable" as const,
  },
  notes: [
    "Gmail uses labels rather than folders.",
    "A move adds the destination label and removes INBOX; other labels remain.",
    "Body search is whole-message search in Gmail rather than body-only.",
  ],
};

const IMAP_FACTS = {
  operations: {
    "search.body": "exact" as const,
    "search.has_attachment": "unavailable" as const,
    "search.flagged": "exact" as const,
    "organization.containers": "exact" as const,
    "organization.move": "different" as const,
    "organization.copy": "exact" as const,
    "delete.permanent": "exact" as const,
  },
  notes: [
    "This is the IMAP protocol baseline; individual servers can differ.",
    "Attachment-only search is not part of baseline IMAP SEARCH.",
    "Move can use a COPY/delete fallback when an IMAP server lacks MOVE.",
  ],
};

/** Records every provider call so a test can assert on what really ran. */
interface ExecutionSpy {
  calls: BulkExecutionRequest[];
}

function makeDeps(
  store: Record<string, Row[]>,
  spy: ExecutionSpy,
  options: {
    hooks?: FakeHooks;
    provider?: "gmail" | "imap";
    outcome?: (request: BulkExecutionRequest) => {
      succeeded: number;
      failed: number;
      error_code?: string | null;
    };
    onExecute?: () => void;
  } = {},
): BulkDeps {
  return {
    db: fakeDb(store, options.hooks ?? {}),
    encrypt: (plaintext: string) => Promise.resolve(CIPHER_PREFIX + plaintext),
    decrypt: (ciphertext: string) =>
      ciphertext.startsWith(CIPHER_PREFIX)
        ? Promise.resolve(ciphertext.slice(CIPHER_PREFIX.length))
        : Promise.reject(new Error("bad ciphertext")),
    compatibility: () => (options.provider === "imap" ? IMAP_FACTS : GMAIL_FACTS),
    execute: (request: BulkExecutionRequest) => {
      spy.calls.push(request);
      options.onExecute?.();
      const outcome = options.outcome?.(request) ??
        { succeeded: request.message_ids.length, failed: 0 };
      return Promise.resolve(outcome);
    },
    appUrl: APP_URL,
    now: () => NOW,
  };
}

function newStore(): Record<string, Row[]> {
  return { bulk_plans: [] };
}

function newSpy(): ExecutionSpy {
  return { calls: [] };
}

function envelopeOf(result: { result: { structuredContent?: Record<string, unknown> } }) {
  const envelope = result.result.structuredContent;
  assert(envelope !== undefined, "every bulk tool result must carry an envelope");
  return envelope as Record<string, any>;
}

/** Create a delete plan and return its id. */
async function seedPlan(
  deps: BulkDeps,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const result = await createBulkPlan(deps, caller, {
    action: "delete_batch",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: FROZEN_IDS,
    ...overrides,
  } as any);
  return envelopeOf(result).plan.plan_id;
}

// ---------------------------------------------------------------------------
// THE GATE — the property that protects every existing user
// ---------------------------------------------------------------------------

Deno.test("a client that has not opted in is never planned for", () => {
  // This is the regression that would hurt most: these four actions have always
  // executed immediately, and non-UI integrations depend on that. Only the
  // exact string "plan" may divert them. Everything else — including a null
  // from a database without the column and an undefined from a failed read —
  // must mean "run it now".
  assertEquals(shouldPlanForMode("plan"), true, "the opt-in value plans");
  for (const mode of ["off", "", "dashboard", "inline", "PLAN", " plan", null, undefined]) {
    assertEquals(
      shouldPlanForMode(mode as any),
      false,
      `mode ${JSON.stringify(mode)} must execute immediately, not plan`,
    );
  }
});

// ---------------------------------------------------------------------------
// Plan creation
// ---------------------------------------------------------------------------

Deno.test("match_count is the exact resolved id count, and the ids are frozen", async () => {
  const store = newStore();
  const deps = makeDeps(store, newSpy());

  const result = await createBulkPlan(deps, caller, {
    action: "search_and_delete",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: FROZEN_IDS,
    search: { from: "news@example.com", unread: true },
    sample: [{ from: "news@example.com", subject: "Digest", date: "2026-07-30T08:12:00Z" }],
  });

  const plan = envelopeOf(result).plan;
  assertEquals(plan.match_count, 3, "match_count must equal the resolved id count exactly");
  assertEquals(plan.operation, "email_delete", "operation is derived from the action");
  assertEquals(plan.action, "search_and_delete", "action is echoed");
  assertEquals(plan.scope.kind, "search", "a search-derived plan is kind 'search'");

  // The stored scope holds those ids and nothing else re-runnable.
  const row = store.bulk_plans[0];
  assertEquals(row.match_count, 3, "the row records the exact count");
  assertEquals(row.status, "pending", "a new plan is pending");
  assertEquals(row.scope_encrypted, true, "the scope is written encrypted");
  const stored = JSON.parse(String(row.scope.data).slice(CIPHER_PREFIX.length));
  assertEquals(stored.message_ids, FROZEN_IDS, "the frozen ids are exactly the resolved ids");
  assert(!("search" in stored), "the search must NOT be stored — re-running it is the whole risk");
  assert(!("query" in stored), "no re-runnable query may be stored");
});

Deno.test("the plan expires 15 minutes out, per contract §3", async () => {
  const store = newStore();
  const deps = makeDeps(store, newSpy());
  const result = await createBulkPlan(deps, caller, {
    action: "delete_batch",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: FROZEN_IDS,
  });
  const plan = envelopeOf(result).plan;
  assertEquals(BULK_PLAN_TTL_MS, 15 * 60 * 1000, "the TTL is 15 minutes");
  assertEquals(
    plan.expires_at,
    new Date(NOW + BULK_PLAN_TTL_MS).toISOString(),
    "expires_at is created_at + TTL",
  );
});

Deno.test("no message content reaches the database, and no sample reaches the model", async () => {
  const store = newStore();
  const deps = makeDeps(store, newSpy());
  const sample = [
    { from: "news@example.com", subject: "SENTINEL-SUBJECT", date: "2026-07-30T08:12:00Z" },
  ];
  const result = await createBulkPlan(deps, caller, {
    action: "search_and_delete",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: FROZEN_IDS,
    search: { from: "news@example.com" },
    sample,
  });

  // The card gets the sample (contract §3) …
  assertEquals(envelopeOf(result).plan.sample, sample, "the card receives the sample rows");

  // … the model does not (contract §7) …
  const modelText = result.result.content[0].text;
  assert(
    !modelText.includes("SENTINEL-SUBJECT"),
    "sample subjects must never enter model context",
  );
  assert(modelText.includes("3 message"), "but the match count may — and should");

  // … and the database gets neither.
  const serialised = JSON.stringify(store.bulk_plans[0]);
  assert(
    !serialised.includes("SENTINEL-SUBJECT"),
    "no subject may be persisted; bulk_plans holds identifiers only",
  );
});

Deno.test("a search that matched nothing still produces a renderable plan", async () => {
  // Rather than an unrenderable "0 results" payload under a card.
  const store = newStore();
  const deps = makeDeps(store, newSpy());
  const result = await createBulkPlan(deps, caller, {
    action: "search_and_delete",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: [],
    search: { from: "nobody@example.com" },
  });
  const plan = envelopeOf(result).plan;
  assertEquals(plan.match_count, 0, "zero matches is a legitimate plan");
  assertEquals(envelopeOf(result).card, "bulk_plan", "and it still renders as a plan card");
});

Deno.test("a failed plan write changes nothing and reports a renderable receipt", async () => {
  const store = newStore();
  const deps = makeDeps(store, newSpy(), { hooks: { failTable: "bulk_plans" } });
  const result = await createBulkPlan(deps, caller, {
    action: "delete_batch",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: FROZEN_IDS,
  });
  const envelope = envelopeOf(result);
  assertEquals(envelope.card, "receipt", "a failure is still renderable");
  assertEquals(envelope.receipt.error_code, "plan_write_failed", "with an explicit code");
  assertEquals(envelope.receipt.affected_count, 0, "and nothing was touched");
});

// ---------------------------------------------------------------------------
// Execution — exactly the frozen set, exactly once
// ---------------------------------------------------------------------------

Deno.test("bulk_execute runs exactly the stored id set", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps, { permanent: false });

  const result = await runBulkExecute(deps, caller, { plan_id: planId });

  assertEquals(spy.calls.length, 1, "the provider path runs once");
  assertEquals(spy.calls[0].message_ids, FROZEN_IDS, "with exactly the frozen ids");
  assertEquals(spy.calls[0].inbox_id, INBOX, "on the plan's inbox");
  assertEquals(spy.calls[0].permanent, false, "with the plan's permanent flag");

  const envelope = envelopeOf(result);
  assertEquals(envelope.card, "receipt", "and returns a §4 receipt");
  assertEquals(envelope.receipt.outcome, "executed", "marked executed");
  assertEquals(envelope.receipt.affected_count, 3, "with the affected count");
  assertEquals(store.bulk_plans[0].status, "executed", "and the row is terminal");
  assertEquals(store.bulk_plans[0].affected_count, 3, "with the count recorded for audit");
});

Deno.test("THE SCOPE IS SERVER-HELD: no argument can influence what runs", async () => {
  // The load-bearing property of this feature. `visibility: ["app"]` is not a
  // boundary (Phase 0 Q2), so assume a prompt-injected agent is calling this
  // and trying every way it can think of to widen the blast radius.
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps, {
    action: "move_batch",
    destination_id: "Label_Archive",
    destination_label: "Archive",
  });

  await runBulkExecute(deps, caller, {
    plan_id: planId,
    // Everything a hostile caller might try to smuggle in.
    message_ids: ["victim-1", "victim-2"],
    permanent: true,
    destination_id: "Label_Trash",
    destination_label: "Trash",
    inbox_id: OTHER_INBOX,
    workspace_id: OTHER_WORKSPACE,
    limit: 500,
    search: { from: "everyone@example.com" },
    action: "search_and_delete",
  } as any);

  assertEquals(spy.calls.length, 1, "one execution");
  const ran = spy.calls[0];
  assertEquals(ran.message_ids, FROZEN_IDS, "the ids came from the row, not the arguments");
  assert(!ran.message_ids.includes("victim-1"), "injected ids are ignored entirely");
  assertEquals(ran.permanent, false, "the permanent flag came from the row");
  assertEquals(ran.destination_id, "Label_Archive", "the destination came from the row");
  assertEquals(ran.inbox_id, INBOX, "the inbox came from the row");
  assertEquals(ran.action, "move_batch", "the action came from the row");
});

Deno.test("a replayed plan_id is refused and does not run again", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  await runBulkExecute(deps, caller, { plan_id: planId });
  const replay = await runBulkExecute(deps, caller, { plan_id: planId });

  assertEquals(spy.calls.length, 1, "the second call must NOT reach the provider");
  const envelope = envelopeOf(replay);
  assertEquals(envelope.card, "receipt", "the replay is still renderable");
  assertEquals(envelope.state, "decided_elsewhere", "reported as already decided");
  assertEquals(envelope.receipt.affected_count, 0, "and affected nothing");
  assertEquals(replay.result.isError, true, "and is an error result");
});

Deno.test("losing the claim race stops execution dead", async () => {
  // The status read in loadPendingPlan is NOT the protection — two concurrent
  // calls can both pass it while the row is still pending. The atomic
  // `.eq("status","pending")` claim is. This simulates the exact interleaving:
  // the row is decided by someone else in the window between this call's read
  // and its own claim landing.
  const store = newStore();
  const spy = newSpy();
  let planted = false;
  const deps = makeDeps(store, spy, {
    hooks: {
      beforeWrite: (table, op) => {
        if (table !== "bulk_plans" || op !== "update" || planted) return;
        planted = true;
        // The rival call claimed it a microsecond ago.
        store.bulk_plans[0].status = "executing";
      },
    },
  });
  const planId = await seedPlan(deps);

  const result = await runBulkExecute(deps, caller, { plan_id: planId });

  assertEquals(spy.calls.length, 0, "a lost claim must never reach the provider");
  const envelope = envelopeOf(result);
  assertEquals(envelope.state, "decided_elsewhere", "the loser reports the race");
  assertEquals(envelope.receipt.affected_count, 0, "and having changed nothing");
});

Deno.test("two concurrent executes of one plan run it once", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  const results = await Promise.all([
    runBulkExecute(deps, caller, { plan_id: planId }),
    runBulkExecute(deps, caller, { plan_id: planId }),
  ]);

  assertEquals(spy.calls.length, 1, "exactly one of the two concurrent calls may execute");
  const affected = results.map((r) => envelopeOf(r).receipt.affected_count).sort();
  assertEquals(affected, [0, 3], "one did the work, the other did nothing");
});

Deno.test("an expired plan is refused, retired, and never runs", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  // Move the clock past the TTL.
  const laterDeps: BulkDeps = { ...deps, now: () => NOW + BULK_PLAN_TTL_MS + 1 };
  const result = await runBulkExecute(laterDeps, caller, { plan_id: planId });

  assertEquals(spy.calls.length, 0, "an expired plan must not reach the provider");
  const envelope = envelopeOf(result);
  assertEquals(envelope.state, "expired", "reported as expired");
  assertEquals(envelope.receipt.outcome, "expired", "with an expired receipt");
  assertEquals(store.bulk_plans[0].status, "expired", "and the row is retired on the spot");
  assertEquals(envelope.actor.reason, "expired", "actor.reason is enumerated");
});

Deno.test("isPlanExpired is exclusive of a plan that is exactly at its deadline", () => {
  const plan = { expires_at: new Date(NOW).toISOString() };
  assert(isPlanExpired(plan, NOW), "a plan is dead at its deadline, not after it");
  assert(!isPlanExpired(plan, NOW - 1), "and alive one millisecond before");
  assert(!isPlanExpired({ expires_at: null }, NOW), "a missing deadline never expires");
});

// ---------------------------------------------------------------------------
// Isolation — and no existence oracle
// ---------------------------------------------------------------------------

Deno.test("a cross-workspace plan_id is indistinguishable from a nonexistent one", async () => {
  // If these two differed by a single byte, a hostile agent could enumerate
  // which plan ids exist in other workspaces.
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);
  store.bulk_plans[0].workspace_id = OTHER_WORKSPACE;

  const foreign = await runBulkExecute(deps, caller, { plan_id: planId });
  const missing = await runBulkExecute(deps, caller, { plan_id: MISSING_PLAN });

  assertEquals(spy.calls.length, 0, "neither may reach the provider");
  assertEquals(
    JSON.stringify(foreign.result),
    JSON.stringify(missing.result),
    "the two responses must be byte-identical",
  );
  assertEquals(
    envelopeOf(foreign).receipt.error_code,
    "not_found",
    "and both say only 'not found'",
  );
  assertEquals(store.bulk_plans[0].status, "pending", "the foreign row is untouched");
});

Deno.test("the inbox allowlist is enforced, and fails the same way", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  const restricted: BulkCaller = { ...caller, inbox_ids: [OTHER_INBOX] };
  const denied = await runBulkExecute(deps, restricted, { plan_id: planId });
  const missing = await runBulkExecute(deps, restricted, { plan_id: MISSING_PLAN });

  assertEquals(spy.calls.length, 0, "a key outside the allowlist may not execute");
  assertEquals(
    JSON.stringify(denied.result),
    JSON.stringify(missing.result),
    "denial is indistinguishable from absence",
  );
  assertEquals(store.bulk_plans[0].status, "pending", "and the plan is left alone");
});

Deno.test("an empty allowlist denies everything", async () => {
  // `!== null` rather than `length > 0`: an empty allowlist is the fail-safe
  // reading of "this key may touch exactly these inboxes", i.e. none.
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  const result = await runBulkExecute(deps, { ...caller, inbox_ids: [] }, { plan_id: planId });
  assertEquals(spy.calls.length, 0, "an empty allowlist grants nothing");
  assertEquals(envelopeOf(result).receipt.error_code, "not_found", "and says nothing else");
});

Deno.test("a malformed plan_id never reaches the database", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  await seedPlan(deps);

  for (const bad of ["", "not-a-uuid", "../../etc", 42, null, undefined, { id: 1 }]) {
    const result = await runBulkExecute(deps, caller, { plan_id: bad } as any);
    assertEquals(
      envelopeOf(result).receipt.error_code,
      "invalid_plan_id",
      `plan_id ${JSON.stringify(bad)} must be rejected up front`,
    );
  }
  assertEquals(spy.calls.length, 0, "and nothing ran");
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

Deno.test("a plan whose scope cannot be decrypted is refused, not guessed at", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);
  store.bulk_plans[0].scope = { v: 1, data: "corrupted-not-our-ciphertext" };

  const result = await runBulkExecute(deps, caller, { plan_id: planId });
  assertEquals(spy.calls.length, 0, "an unreadable scope must never be executed");
  assertEquals(envelopeOf(result).receipt.error_code, "scope_unreadable", "and says so");
  assertEquals(store.bulk_plans[0].status, "failed", "and the plan is retired");
});

Deno.test("a provider error retires the plan rather than leaving it retryable", async () => {
  // Some of the messages may already have been changed, so a retry could act
  // twice. Same reasoning as the stale-'sending' rule for scheduled sends.
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy, {
    onExecute: () => {
      throw new Error("gmail_auth_failed");
    },
  });
  const planId = await seedPlan(deps);

  const result = await runBulkExecute(deps, caller, { plan_id: planId });
  assertEquals(envelopeOf(result).receipt.error_code, "provider_error", "reported as a failure");
  assertEquals(store.bulk_plans[0].status, "failed", "and terminal, not pending");

  const retry = await runBulkExecute(deps, caller, { plan_id: planId });
  assertEquals(spy.calls.length, 1, "a failed plan cannot be re-run");
  assertEquals(envelopeOf(retry).state, "decided_elsewhere", "it reports its terminal state");
});

Deno.test("a partial failure is reported honestly, not rounded up", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy, {
    outcome: () => ({ succeeded: 2, failed: 1, error_code: "message_not_found" }),
  });
  const planId = await seedPlan(deps);

  const envelope = envelopeOf(await runBulkExecute(deps, caller, { plan_id: planId }));
  assertEquals(envelope.receipt.affected_count, 2, "only what actually changed is counted");
  assert(
    envelope.receipt.detail.includes("1 could not be changed"),
    "and the remainder is stated, not hidden",
  );
});

// ---------------------------------------------------------------------------
// bulk_cancel
// ---------------------------------------------------------------------------

Deno.test("bulk_cancel retires the plan and records who declined it", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  const result = await runBulkCancel(deps, caller, { plan_id: planId });

  assertEquals(spy.calls.length, 0, "cancelling touches no mail");
  const envelope = envelopeOf(result);
  assertEquals(envelope.receipt.outcome, "cancelled", "the receipt says cancelled");
  assertEquals(envelope.receipt.affected_count, 0, "and nothing was affected");
  assertEquals(store.bulk_plans[0].status, "cancelled", "the row is terminal");
  assertEquals(
    store.bulk_plans[0].cancelled_by_api_key_id,
    KEY,
    "and records the key, which is the whole point of cancelling over lapsing",
  );
});

Deno.test("a cancelled plan can never be executed", async () => {
  const store = newStore();
  const spy = newSpy();
  const deps = makeDeps(store, spy);
  const planId = await seedPlan(deps);

  await runBulkCancel(deps, caller, { plan_id: planId });
  const result = await runBulkExecute(deps, caller, { plan_id: planId });

  assertEquals(spy.calls.length, 0, "a declined plan is dead");
  assertEquals(envelopeOf(result).state, "decided_elsewhere", "and says so");
});

Deno.test("cancel enforces the same isolation guards as execute", async () => {
  const store = newStore();
  const deps = makeDeps(store, newSpy());
  const planId = await seedPlan(deps);
  store.bulk_plans[0].workspace_id = OTHER_WORKSPACE;

  const foreign = await runBulkCancel(deps, caller, { plan_id: planId });
  const missing = await runBulkCancel(deps, caller, { plan_id: MISSING_PLAN });
  assertEquals(
    JSON.stringify(foreign.result),
    JSON.stringify(missing.result),
    "cancel must not become an existence oracle either",
  );
  assertEquals(store.bulk_plans[0].status, "pending", "and the foreign plan is untouched");
});

// ---------------------------------------------------------------------------
// Contract §5 — provider semantics
// ---------------------------------------------------------------------------

Deno.test("delete caveats say what delete really means on each provider", () => {
  const gmail = bulkProviderBlock({
    provider: "gmail",
    action: "delete_batch",
    permanent: false,
    facts: GMAIL_FACTS,
  });
  assertEquals(gmail.label, "Gmail API", "labelled by transport");
  assertEquals(gmail.route, "users.messages.trash", "and the concrete call");
  assert(
    gmail.caveats[0].includes("Trash") && gmail.caveats[0].includes("not available on Gmail"),
    `Gmail delete must state recoverability: ${gmail.caveats[0]}`,
  );

  const imapPermanent = bulkProviderBlock({
    provider: "imap",
    action: "search_and_delete",
    permanent: true,
    facts: IMAP_FACTS,
  });
  assert(
    imapPermanent.caveats[0].includes("cannot be undone"),
    `a real permanent delete must say so: ${imapPermanent.caveats[0]}`,
  );
  assert(
    imapPermanent.route.includes("EXPUNGE"),
    `and name the call: ${imapPermanent.route}`,
  );
});

Deno.test("move caveats explain Gmail's label model", () => {
  const gmail = bulkProviderBlock({
    provider: "gmail",
    action: "move_batch",
    permanent: false,
    facts: GMAIL_FACTS,
  });
  assertEquals(
    gmail.caveats[0],
    "A move adds the destination label and removes INBOX; other labels remain.",
    "verbatim from COMPATIBILITY_PROFILES, which contract §5 names as the source",
  );
  assert(
    gmail.caveats.includes("Gmail uses labels rather than folders."),
    "and the container model is stated too",
  );
});

Deno.test("caveats are selected by operation, never dumped wholesale", () => {
  const block = bulkProviderBlock({
    provider: "gmail",
    action: "delete_batch",
    permanent: false,
    facts: GMAIL_FACTS,
  });
  assert(block.caveats.length <= 3, "contract §5 allows at most three");
  assert(
    !block.caveats.some((c) => c.includes("labels rather than folders")),
    "a delete card must not carry move/container notes",
  );
  assert(
    !block.caveats.some((c) => c.includes("Body search")),
    "nor a search note the plan never used",
  );
});

Deno.test("a search caveat appears only when the plan actually used that field", () => {
  const withBody = bulkProviderBlock({
    provider: "gmail",
    action: "search_and_delete",
    permanent: false,
    facts: GMAIL_FACTS,
    searchFields: ["body", "from"],
  });
  assert(
    withBody.caveats.some((c) => c.includes("Body search")),
    "a body search on Gmail is genuinely different and must be surfaced",
  );

  const withoutBody = bulkProviderBlock({
    provider: "gmail",
    action: "search_and_delete",
    permanent: false,
    facts: GMAIL_FACTS,
    searchFields: ["from"],
  });
  assert(
    !withoutBody.caveats.some((c) => c.includes("Body search")),
    "but warning about a field the plan never used is noise",
  );
});

// ---------------------------------------------------------------------------
// Contract §3 — the scope description
// ---------------------------------------------------------------------------

Deno.test("the scope description is readable English, server-authored", () => {
  assertEquals(
    describeScope({
      kind: "search",
      matchCount: 128,
      search: { unread: true, from: "news@example.com", before: "2026-07-01" },
    }),
    "128 messages unread, from news@example.com, received before 2026-07-01",
    "the card must not have to reconstruct a search object",
  );
  assertEquals(
    describeScope({ kind: "explicit_ids", matchCount: 1 }),
    "1 message selected by id",
    "and singular reads correctly",
  );
});

Deno.test("the scope description cannot lie about what will be deleted", () => {
  // The search terms are caller-supplied and the folder name comes from the
  // mailbox, and both are interpolated straight into the sentence a reviewer
  // reads before clicking Execute. A U+202E in either would reverse the tail of
  // that sentence.
  const description = describeScope({
    kind: "search",
    matchCount: 128,
    search: { subject: `Invoice ${RLO}FDP.exe` },
    folder: `Archive${RLO}`,
  });
  assert(!description.includes(RLO), "no bidi override survives into the description");
  assert(
    description.includes("Invoice FDP.exe"),
    `the term is still shown, just honestly: ${description}`,
  );
});

Deno.test("plan sample rows are neutralised before they leave the server", async () => {
  // `from` is a sender display name and `subject` is a subject line: both are
  // written by whoever sent the message. This is the only part of a bulk
  // envelope that comes straight from inbound mail.
  const store = newStore();
  const deps = makeDeps(store, newSpy());
  const result = await createBulkPlan(deps, caller, {
    action: "search_and_delete",
    inbox: { id: INBOX, email_address: "me@example.com", provider: "gmail" },
    message_ids: FROZEN_IDS,
    search: { from: "news@example.com" },
    destination_label: `Trash${RLO}`,
    folder: `INBOX${RLO}`,
    sample: [
      {
        from: `Accounts ${RLO}<evil@x.com>`,
        subject: `invoice${RLO} fdp.exe`,
        date: "2026-07-30T08:12:00Z",
      },
    ],
  });

  const plan = envelopeOf(result).plan;
  assertEquals(plan.sample[0].from, "Accounts <evil@x.com>", "sender label");
  assertEquals(plan.sample[0].subject, "invoice fdp.exe", "subject line");
  assertEquals(plan.scope.folder, "INBOX", "folder label");
  assertEquals(plan.scope.destination, "Trash", "destination label");
  assert(
    !JSON.stringify(envelopeOf(result)).includes(RLO),
    "no bidi override anywhere in the plan envelope",
  );
  assert(
    !result.result.content[0].text.includes(RLO),
    "nor in the model-visible prose",
  );
});

Deno.test("a capped search says so, since the cap changes what survives", () => {
  const description = describeScope({
    kind: "search",
    matchCount: 500,
    search: { from: "news@example.com" },
    capped: true,
    limit: 500,
  });
  assert(
    description.includes("capped at the 500-message limit"),
    `a truncated selection must be visible: ${description}`,
  );
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

Deno.test("the tool surface is app-only, single-argument, and correctly scoped", () => {
  assertEquals([...BULK_TOOL_NAMES], ["bulk_execute", "bulk_cancel"], "two tools");
  assert(isBulkToolName("bulk_execute"), "recognised by name");
  assert(!isBulkToolName("email_delete"), "and does not claim the mail tools");
  assertEquals(runBulkTool("nope", {} as any, caller, {}), null, "unknown names 404");

  for (const definition of BULK_TOOL_DEFINITIONS) {
    assertEquals(
      Object.keys(definition.inputSchema.properties as Record<string, unknown>),
      ["plan_id"],
      `${definition.name} takes plan_id and nothing else — the scope is server-held`,
    );
    assertEquals(
      (definition.inputSchema as Record<string, unknown>).additionalProperties,
      false,
      `${definition.name} must refuse unknown properties`,
    );
    assertEquals(definition.requiredScope, "delete:email", `${definition.name} scope`);
    assertEquals(definition.altScopes, ["manage:folders"], `${definition.name} alt scope`);

    // The outputSchema half of the same definition. Its value is that it is
    // UNVIOLATABLE: the spec makes a declared output schema a MUST ("servers
    // MUST provide structured results that conform"), and a receipt payload is
    // merged into the envelope object, so a strict schema here would turn a
    // working call into a rejected tool result the first time a receipt field
    // moved. additionalProperties: true with no `required` is what keeps the
    // declaration free of that risk. Pinned so nobody "tightens" it later
    // without reading this.
    const out = definition.outputSchema as Record<string, unknown> | undefined;
    assert(out, `${definition.name} must declare an outputSchema`);
    assertEquals(out!.type, "object", `${definition.name} outputSchema is an object`);
    assertEquals(
      out!.additionalProperties,
      true,
      `${definition.name} outputSchema must stay permissive`,
    );
    assertEquals(
      out!.required,
      undefined,
      `${definition.name} outputSchema must require no key`,
    );
  }

  const execute = BULK_TOOL_DEFINITIONS.find((d) => d.name === "bulk_execute")!;
  assertEquals(
    execute.annotations?.destructiveHint,
    true,
    "executing can delete mail and must be hinted as destructive",
  );
  const cancel = BULK_TOOL_DEFINITIONS.find((d) => d.name === "bulk_cancel")!;
  assertEquals(
    cancel.annotations?.destructiveHint,
    false,
    "cancelling prevents a change; the fail-safe direction is not destructive",
  );
});

Deno.test("operationForAction maps each action to its consolidated tool", () => {
  assertEquals(operationForAction("delete_batch"), "email_delete", "delete_batch");
  assertEquals(operationForAction("search_and_delete"), "email_delete", "search_and_delete");
  assertEquals(operationForAction("move_batch"), "email_organize", "move_batch");
  assertEquals(operationForAction("search_and_move"), "email_organize", "search_and_move");
});

Deno.test("every receipt carries an absolute dashboard_url", async () => {
  // `ui/open-link` will not take a bare path, so a relative one forces the card
  // to hardcode an origin.
  const store = newStore();
  const deps = makeDeps(store, newSpy());
  const planId = await seedPlan(deps);

  const receipts = [
    envelopeOf(await runBulkExecute(deps, caller, { plan_id: MISSING_PLAN })),
    envelopeOf(await runBulkExecute(deps, caller, { plan_id: planId })),
    envelopeOf(await runBulkCancel(deps, caller, { plan_id: planId })),
  ];
  for (const envelope of receipts) {
    const url = envelope.receipt.dashboard_url;
    assert(
      typeof url === "string" && url.startsWith("https://"),
      `dashboard_url must be absolute, got ${JSON.stringify(url)}`,
    );
    assert(!("dashboard_path" in envelope.receipt), "the old relative field is gone");
  }
});
