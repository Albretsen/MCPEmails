// ---------------------------------------------------------------------------
// MCP Apps approval-domain tests.
//
// The first test in this file is the security invariant of the whole feature:
// `approval_decide` refuses `"approve"`. Everything else guards the properties
// that make the other three tools safe to expose to a caller we assume is
// hostile — workspace scoping, expiry, and the atomic claim that keeps a card
// decision and a dashboard decision from both "winning".
//
// The handlers take their database, crypto and origin as injected dependencies
// (`ApprovalDeps`), so the guards are exercised directly here rather than
// through index.ts, which cannot be imported by a test (it calls Deno.serve and
// builds a service-role client at module load).
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

// The fake PostgREST store below mirrors an untyped query builder; `any` is the
// honest type for its rows.
// deno-lint-ignore-file no-explicit-any

import {
  APPROVAL_TOOL_DEFINITIONS,
  APPROVAL_TOOL_NAMES,
  APPROVAL_TTL_MS,
  approvalLapsedBeforeDecision,
  approvalReviewUrl,
  type ApprovalCaller,
  type ApprovalDeps,
  buildApprovalSummary,
  buildHeldSendEnvelope,
  clipBody,
  heldSendToolResult,
  isApprovalExpired,
  isApprovalToolName,
  runApprovalDecide,
  runApprovalReview,
  runApprovalSchedule,
  runApprovalUpdate,
  summaryFromSnapshot,
  summaryIsComplete,
  writeTolerantly,
} from "./mcp-app-approvals.ts";

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
// Faithful enough for the properties under test: `.eq()` filters really are
// applied to updates, so an `.eq("status","pending")` claim that matches
// nothing really does return null — which is exactly the concurrency behaviour
// the production code depends on.
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

interface FakeHooks {
  /** Columns the "database" does not have, to exercise writeTolerantly. */
  missingColumns?: string[];
  /** Runs before a write is applied, so a test can simulate a lost race. */
  beforeWrite?: (table: string, op: string) => void;
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
  order(): FakeQuery {
    return this;
  }
  limit(): FakeQuery {
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
    const rows = this.store[this.table] ?? (this.store[this.table] = []);
    const missing = (this.hooks.missingColumns ?? []).filter((c) => c in this.patch);
    if (this.op !== "select" && missing.length > 0) {
      return Promise.resolve({
        data: null,
        error: { code: "PGRST204", message: `Could not find the '${missing[0]}' column` },
      });
    }
    if (this.op !== "select") this.hooks.beforeWrite?.(this.table, this.op);

    if (this.op === "insert") {
      const row = { id: `generated-${rows.length}`, ...this.patch };
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
const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const OTHER_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const INBOX = "55555555-5555-4555-8555-555555555555";
const OTHER_INBOX = "66666666-6666-4666-8666-666666666666";
const KEY = "77777777-7777-4777-8777-777777777777";

const CIPHER_PREFIX = "cipher:";
const SECRET_BODY = "Wire the funds to account 12345. SENTINEL-BODY-TEXT";

const SNAPSHOT = {
  to: ["a@x.com"],
  cc: [],
  bcc: ["hidden@x.com"],
  subject: "Original subject",
  body: SECRET_BODY,
  html_body: "<p>SENTINEL-BODY-HTML</p>",
  attachments: [{ filename: "q3.pdf", mime_type: "application/pdf", data: "AAAA" }],
};

const caller: ApprovalCaller = {
  id: KEY,
  workspace_id: WORKSPACE,
  name: "Claude",
  inbox_ids: null,
};

function pendingApproval(overrides: Row = {}): Row {
  return {
    id: APPROVAL_ID,
    workspace_id: WORKSPACE,
    inbox_id: INBOX,
    api_key_id: KEY,
    operation: "email_send",
    payload: { v: 1, data: CIPHER_PREFIX + JSON.stringify(SNAPSHOT) },
    payload_encrypted: true,
    summary: {
      to: ["a@x.com"],
      cc: [],
      bcc_count: 1,
      subject: "Original subject",
      attachment_count: 1,
    },
    send_at: null,
    status: "pending",
    created_at: "2026-08-05T10:00:00.000Z",
    expires_at: "2026-08-06T10:00:00.000Z",
    decided_at: null,
    decided_via: null,
    decided_by_api_key_id: null,
    ...overrides,
  };
}

function inboxRow(overrides: Row = {}): Row {
  return {
    id: INBOX,
    email_address: "me@example.com",
    display_name: "Asgeir",
    provider: "gmail",
    service: null,
    smtp_host: null,
    smtp_port: null,
    signature_enabled: true,
    signature_text: "--\nAsgeir, MCP Emails",
    signature_html: null,
    signature_source: "manual",
    ...overrides,
  };
}

function makeDeps(store: Record<string, Row[]>, hooks: FakeHooks = {}): ApprovalDeps {
  return {
    db: fakeDb(store, hooks),
    encrypt: (plaintext: string) => Promise.resolve(CIPHER_PREFIX + plaintext),
    decrypt: (ciphertext: string) =>
      ciphertext.startsWith(CIPHER_PREFIX)
        ? Promise.resolve(ciphertext.slice(CIPHER_PREFIX.length))
        : Promise.reject(new Error("bad ciphertext")),
    appUrl: "https://mcpemails.com",
    now: () => NOW,
  };
}

function freshStore(approvalOverrides: Row = {}): Record<string, Row[]> {
  return {
    send_approvals: [pendingApproval(approvalOverrides)],
    inboxes: [inboxRow()],
    api_keys: [{ id: KEY, name: "Claude" }],
    mcp_client_capabilities: [{ api_key_id: KEY, client_name: "claude-ai" }],
  };
}

function envelopeOf(result: { result: { structuredContent?: Record<string, unknown> } }) {
  const envelope = result.result.structuredContent;
  assert(envelope !== undefined, "every approval tool result must carry an envelope");
  return envelope as Record<string, any>;
}

// ---------------------------------------------------------------------------
// THE SECURITY INVARIANT
// ---------------------------------------------------------------------------

Deno.test("approval_decide REFUSES approve, unconditionally", async () => {
  // This is the single load-bearing rule of the feature (contract.md §6).
  // `visibility: ["app"]` is a host UI hint, not an authorisation boundary: the
  // server cannot tell an app-originated tools/call from a model-originated
  // one, so anything reachable here is reachable by a prompt-injected agent.
  // Approving is irreversible and exfiltration-capable, so it is not reachable
  // here at all. If this test fails, do not "fix" it by widening the tool.
  const store = freshStore();
  const result = await runApprovalDecide(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    decision: "approve",
  });

  const envelope = envelopeOf(result);
  assertEquals(envelope.state, "error", "approve must not produce a decision");
  assertEquals(
    envelope.receipt.error_code,
    "approve_requires_browser_session",
    "approve must be refused with an explicit reason",
  );
  assert(result.result.isError === true, "approve must be an error result");

  // And, above all: the row is untouched.
  assertEquals(store.send_approvals[0].status, "pending", "the approval must stay pending");
  assertEquals(store.send_approvals[0].decided_at, null, "no decision may be recorded");
  assertEquals(store.send_approvals[0].decided_via, null, "no surface may be recorded");
});

Deno.test("no argument, claim, or spelling gets an approve past the guard", async () => {
  // Everything a hostile caller might try: alternate spellings, a truthy
  // object, an array, extra arguments asserting authority it does not have.
  const attempts: unknown[] = [
    { approval_id: APPROVAL_ID, decision: "approve" },
    { approval_id: APPROVAL_ID, decision: "APPROVE" },
    { approval_id: APPROVAL_ID, decision: "Approve " },
    { approval_id: APPROVAL_ID, decision: "accept" },
    { approval_id: APPROVAL_ID, decision: "send" },
    { approval_id: APPROVAL_ID, decision: true },
    { approval_id: APPROVAL_ID, decision: ["reject", "approve"] },
    { approval_id: APPROVAL_ID, decision: { value: "reject" } },
    { approval_id: APPROVAL_ID, decision: null },
    { approval_id: APPROVAL_ID },
    // "I am the card / the user / an admin" is not a credential.
    {
      approval_id: APPROVAL_ID,
      decision: "approve",
      caller: "app",
      visibility: "app",
      user_confirmed: true,
      role: "owner",
      approval_token: "anything",
    },
  ];

  for (const args of attempts) {
    const store = freshStore();
    const result = await runApprovalDecide(makeDeps(store), caller, args);
    assertEquals(
      envelopeOf(result).receipt.error_code,
      "approve_requires_browser_session",
      `refused: ${JSON.stringify(args)}`,
    );
    assertEquals(
      store.send_approvals[0].status,
      "pending",
      `row untouched for ${JSON.stringify(args)}`,
    );
  }
});

Deno.test("the decide schema advertises reject and only reject", () => {
  // Belt to the guard's braces: a conforming client is stopped one layer
  // earlier, by input-schema validation in index.ts. Neither layer is
  // redundant — the schema is a convenience, the handler guard is the boundary.
  const decide = APPROVAL_TOOL_DEFINITIONS.find((t) => t.name === "approval_decide")!;
  const properties = decide.inputSchema.properties as Record<string, any>;
  assertEquals(properties.decision.enum, ["reject"], "decision enum");
  assert(
    !JSON.stringify(decide.inputSchema).includes("\"approve\""),
    "the schema must not offer approve as a value",
  );
});

Deno.test("no approval tool can send, approve, or queue a delivery", async () => {
  // A blunt structural check: none of these handlers may ever write to
  // scheduled_sends (the one dispatch path) or set status to 'approved'.
  const store = freshStore();
  const deps = makeDeps(store);
  await runApprovalReview(deps, caller, { approval_id: APPROVAL_ID });
  await runApprovalUpdate(deps, caller, { approval_id: APPROVAL_ID, body_text: "edited" });
  await runApprovalSchedule(deps, caller, {
    approval_id: APPROVAL_ID,
    send_at: "2026-08-05T18:00:00.000Z",
  });
  await runApprovalDecide(deps, caller, { approval_id: APPROVAL_ID, decision: "reject" });

  assertEquals(store.scheduled_sends ?? [], [], "nothing may be queued for delivery");
  assert(
    store.send_approvals.every((row) => row.status !== "approved"),
    "no handler may mark an approval approved",
  );
});

// ---------------------------------------------------------------------------
// Workspace and inbox scoping
// ---------------------------------------------------------------------------

Deno.test("an approval in another workspace is refused, with no existence oracle", async () => {
  const store = freshStore({ workspace_id: OTHER_WORKSPACE });
  const deps = makeDeps(store);

  const crossWorkspace = await runApprovalReview(deps, caller, { approval_id: APPROVAL_ID });
  const doesNotExist = await runApprovalReview(deps, caller, { approval_id: OTHER_ID });

  assertEquals(envelopeOf(crossWorkspace).receipt.error_code, "not_found", "cross-workspace");
  // Byte-identical to "no such approval": the response must not reveal that an
  // id exists somewhere else.
  assertEquals(
    envelopeOf(crossWorkspace),
    envelopeOf(doesNotExist),
    "cross-workspace and unknown must be indistinguishable",
  );

  // Every tool applies the same guard, not just the read.
  for (
    const attempt of [
      runApprovalDecide(deps, caller, { approval_id: APPROVAL_ID, decision: "reject" }),
      runApprovalUpdate(deps, caller, { approval_id: APPROVAL_ID, subject: "hijacked" }),
      runApprovalSchedule(deps, caller, {
        approval_id: APPROVAL_ID,
        send_at: "2026-08-05T18:00:00.000Z",
      }),
    ]
  ) {
    assertEquals(envelopeOf(await attempt).receipt.error_code, "not_found", "guard applied");
  }
  assertEquals(store.send_approvals[0].status, "pending", "the other workspace's row is untouched");
  assertEquals(store.send_approvals[0].summary.subject, "Original subject", "and unedited");
});

Deno.test("a key's inbox allowlist also scopes approvals", async () => {
  const store = freshStore();
  const restricted: ApprovalCaller = { ...caller, inbox_ids: [OTHER_INBOX] };
  const result = await runApprovalReview(makeDeps(store), restricted, {
    approval_id: APPROVAL_ID,
  });
  assertEquals(envelopeOf(result).receipt.error_code, "not_found", "outside the allowlist");

  const allowed: ApprovalCaller = { ...caller, inbox_ids: [INBOX] };
  const ok = await runApprovalReview(makeDeps(store), allowed, { approval_id: APPROVAL_ID });
  assertEquals(envelopeOf(ok).card, "outbound_review", "inside the allowlist");
});

Deno.test("a malformed approval_id never reaches the database", async () => {
  const store = freshStore();
  let touched = false;
  const deps = makeDeps(store, { beforeWrite: () => (touched = true) });
  for (const id of ["", "not-a-uuid", "'; drop table send_approvals; --", 42, null, undefined]) {
    const result = await runApprovalReview(deps, caller, { approval_id: id });
    assertEquals(
      envelopeOf(result).receipt.error_code,
      "invalid_approval_id",
      `rejected: ${String(id)}`,
    );
  }
  assert(!touched, "no write may be attempted for a malformed id");
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

Deno.test("an expired approval is refused and retired on the spot", async () => {
  const store = freshStore({ expires_at: "2026-08-05T11:00:00.000Z" }); // one hour ago
  const result = await runApprovalDecide(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    decision: "reject",
  });

  const envelope = envelopeOf(result);
  assertEquals(envelope.state, "expired", "state");
  assertEquals(envelope.receipt.outcome, "expired", "outcome");
  assertEquals(envelope.actor.can_decide, false, "an expired request is not decidable");

  // Retiring it is what lets a retry with the same idempotency_key create a
  // fresh approval: claimOutboundIdempotency reclaims a pending_approval record
  // whose approval reads rejected/cancelled/expired.
  assertEquals(store.send_approvals[0].status, "expired", "the row is retired");
  assertEquals(
    store.send_approvals[0].decided_via,
    null,
    "the clock is not a decision surface",
  );
});

Deno.test("every tool refuses an expired approval", async () => {
  for (
    const run of [
      (d: ApprovalDeps) => runApprovalReview(d, caller, { approval_id: APPROVAL_ID }),
      (d: ApprovalDeps) => runApprovalUpdate(d, caller, { approval_id: APPROVAL_ID, body_text: "x" }),
      (d: ApprovalDeps) =>
        runApprovalSchedule(d, caller, {
          approval_id: APPROVAL_ID,
          send_at: "2026-08-06T18:00:00.000Z",
        }),
      (d: ApprovalDeps) =>
        runApprovalDecide(d, caller, { approval_id: APPROVAL_ID, decision: "reject" }),
    ]
  ) {
    const store = freshStore({ expires_at: "2026-08-05T11:00:00.000Z" });
    assertEquals(envelopeOf(await run(makeDeps(store))).state, "expired", "expired refused");
  }
});

Deno.test("expiry helpers key the dispatcher gate on the decision, not the delivery", () => {
  assert(!isApprovalExpired({ expires_at: null }, NOW), "no deadline means no expiry");
  assert(!isApprovalExpired({ expires_at: "2026-08-06T10:00:00.000Z" }, NOW), "future deadline");
  assert(isApprovalExpired({ expires_at: "2026-08-05T11:00:00.000Z" }, NOW), "past deadline");

  // Never decided, deadline passed: must never be dispatched.
  assert(
    approvalLapsedBeforeDecision(
      { expires_at: "2026-08-05T11:00:00.000Z", decided_at: null },
      NOW,
    ),
    "an undecided lapsed request is dead",
  );
  // Decided in time, delivering later (an approved send scheduled for next
  // week): this must still go out, or scheduling would silently break.
  assert(
    !approvalLapsedBeforeDecision(
      { expires_at: "2026-08-05T11:00:00.000Z", decided_at: "2026-08-05T10:30:00.000Z" },
      NOW,
    ),
    "a decision inside the window survives its deadline",
  );
  // Somehow decided after the window closed: refuse.
  assert(
    approvalLapsedBeforeDecision(
      { expires_at: "2026-08-05T11:00:00.000Z", decided_at: "2026-08-05T11:30:00.000Z" },
      NOW,
    ),
    "a decision after the window does not resurrect it",
  );
  assertEquals(APPROVAL_TTL_MS, 24 * 60 * 60 * 1000, "24h TTL");
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

Deno.test("the loser of a concurrent decision reports decided_elsewhere", async () => {
  // The dashboard approves in the instant between this call's read and its
  // write. The `.eq("status","pending")` claim must match nothing, and the card
  // must say so rather than overwriting a decision that is already being acted
  // on.
  const store = freshStore();
  let raced = false;
  const deps = makeDeps(store, {
    beforeWrite: (table, op) => {
      if (table === "send_approvals" && op === "update" && !raced) {
        raced = true;
        store.send_approvals[0].status = "approved";
        store.send_approvals[0].decided_via = "dashboard";
      }
    },
  });

  const result = await runApprovalDecide(deps, caller, {
    approval_id: APPROVAL_ID,
    decision: "reject",
  });

  const envelope = envelopeOf(result);
  assertEquals(envelope.state, "decided_elsewhere", "state");
  assertEquals(envelope.receipt.outcome, "decided_elsewhere", "outcome");
  assertEquals(store.send_approvals[0].status, "approved", "the winner's decision stands");
  assertEquals(store.send_approvals[0].decided_via, "dashboard", "and its provenance");
});

Deno.test("an edit that loses the race changes nothing", async () => {
  const store = freshStore();
  let raced = false;
  const deps = makeDeps(store, {
    beforeWrite: (table, op) => {
      if (table === "send_approvals" && op === "update" && !raced) {
        raced = true;
        store.send_approvals[0].status = "approved";
      }
    },
  });

  const result = await runApprovalUpdate(deps, caller, {
    approval_id: APPROVAL_ID,
    body_text: "content the reviewer never saw",
  });

  assertEquals(envelopeOf(result).state, "decided_elsewhere", "state");
  assertEquals(
    store.send_approvals[0].payload.data,
    CIPHER_PREFIX + JSON.stringify(SNAPSHOT),
    "an approved message must not be rewritten under the reviewer",
  );
});

Deno.test("a decision made anywhere else is reported, not overwritten", async () => {
  for (const status of ["approved", "rejected", "cancelled"]) {
    const store = freshStore({ status, decided_via: "dashboard" });
    const result = await runApprovalDecide(makeDeps(store), caller, {
      approval_id: APPROVAL_ID,
      decision: "reject",
    });
    assertEquals(envelopeOf(result).state, "decided_elsewhere", `already ${status}`);
    assertEquals(store.send_approvals[0].status, status, `still ${status}`);
  }
});

// ---------------------------------------------------------------------------
// approval_review
// ---------------------------------------------------------------------------

Deno.test("approval_review returns the contract §2 envelope", async () => {
  const store = freshStore();
  const result = await runApprovalReview(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
  });
  const envelope = envelopeOf(result);

  assertEquals(envelope.schema_version, "review-card-v1", "schema_version");
  assertEquals(envelope.card, "outbound_review", "card");
  assertEquals(envelope.state, "pending", "state");

  const outbound = envelope.outbound;
  assertEquals(outbound.approval_id, APPROVAL_ID, "approval_id");
  assertEquals(outbound.operation, "email_send", "operation");
  assertEquals(outbound.review_url, `https://mcpemails.com/approvals/${APPROVAL_ID}`, "review_url");
  assertEquals(outbound.identity.email_address, "me@example.com", "identity");
  assertEquals(outbound.recipients.to, ["a@x.com"], "to");
  assertEquals(outbound.subject, "Original subject", "subject");
  assertEquals(outbound.body.text, SECRET_BODY, "decrypted body");
  assertEquals(outbound.body.truncated, false, "not truncated");
  assertEquals(outbound.attachments.length, 1, "attachments");
  assertEquals(outbound.attachments[0].filename, "q3.pdf", "attachment filename");
  assertEquals(outbound.signature.will_append, true, "signature");
  assertEquals(outbound.requested_by.api_key_name, "Claude", "requesting key");
  assertEquals(outbound.requested_by.client_name, "claude-ai", "requesting client");
  assertEquals(envelope.provider.label, "Gmail API", "provider label");
  assertEquals(envelope.provider.route, "users.messages.send", "provider route");
  assertEquals(envelope.actor.can_decide, true, "inline actions available");
});

// ---------------------------------------------------------------------------
// The held-send response
//
// THE BUG THESE GUARD. A gated email_compose / draft / schedule call used to
// return the flat `{status:"pending_approval", ...}` object, which carries no
// `schema_version`, so the card's `classifyResult` called it "foreign" and drew
// nothing. The only producer of an `outbound_review` envelope was
// `approval_review`, which the card calls from an already-rendered card: the
// card rendered only if it was already rendered. `tools/list` gates `_meta.ui`
// onto exactly the keys that can hold a send, so the gate gated nothing.
//
// The cross-check that actually matters is in apps/mcp-app/harness, which runs
// the SHIPPED `classifyResult` over this payload. These pin the server half.
// ---------------------------------------------------------------------------

/** The five keys index.ts#pendingApprovalPayload has always returned. */
const PENDING_KEYS = ["status", "approval_id", "inbox_id", "review_url", "message"];

function pendingPayload(extra: Row = {}): Row {
  return {
    status: "pending_approval",
    approval_id: APPROVAL_ID,
    inbox_id: INBOX,
    ...extra,
    review_url: `https://mcpemails.com/approvals/${APPROVAL_ID}`,
    message: "This email has not been sent. It is waiting for a person to approve it.",
  };
}

Deno.test("a held send returns something the card will actually render", async () => {
  const store = freshStore();
  const envelope = await buildHeldSendEnvelope(makeDeps(store), caller, pendingApproval());
  const result = heldSendToolResult(pendingPayload(), envelope);
  const sc = result.structuredContent as Record<string, any>;

  // apps/mcp-app/src/contract.ts#isEnvelope, restated. Two string fields is the
  // whole structural check, and it is the difference between the card rendering
  // and the card staying silent.
  assertEquals(typeof sc.schema_version, "string", "isEnvelope: schema_version");
  assertEquals(typeof sc.card, "string", "isEnvelope: card");
  assertEquals(sc.schema_version, "review-card-v1", "the version the card supports");

  // apps/mcp-app/src/components/App.tsx takes the outbound_review branch on
  // `card === "outbound_review" && envelope.outbound`.
  assertEquals(sc.card, "outbound_review", "discriminator");
  assert(!!sc.outbound, "the payload its discriminator promises");
  assertEquals(sc.state, "pending", "state");
  assertEquals(sc.outbound.approval_id, APPROVAL_ID, "approval_id");
  assertEquals(
    sc.outbound.review_url,
    `https://mcpemails.com/approvals/${APPROVAL_ID}`,
    "the Approve button's target",
  );
  assertEquals(sc.provider.label, "Gmail API", "provider block");
  assertEquals(sc.dashboard_url, "https://mcpemails.com/dashboard/approvals", "dashboard_url");
});

Deno.test("the pending-approval keys survive the merge unchanged", async () => {
  // They are a published output contract: anything already reading them off
  // structuredContent must keep finding them, with the same values.
  const store = freshStore();
  const payload = pendingPayload();
  const envelope = await buildHeldSendEnvelope(makeDeps(store), caller, pendingApproval());
  const sc = heldSendToolResult(payload, envelope).structuredContent as Row;

  for (const key of PENDING_KEYS) {
    assertEquals(sc[key], payload[key], `${key} survives`);
  }
  // schedule_create's extra top-level field, which sits alongside them.
  const scheduled = heldSendToolResult(
    pendingPayload({ send_at: "2026-09-01T09:00:00.000Z" }),
    envelope,
  ).structuredContent as Row;
  assertEquals(scheduled.send_at, "2026-09-01T09:00:00.000Z", "send_at survives");
});

Deno.test("the two key sets are disjoint, so neither side can shadow the other", async () => {
  // The merge is only safe because of this. If someone adds `state` or
  // `dashboard_url` to the pending payload, or `status` to the envelope, one
  // side silently loses, and this is where it gets caught.
  const store = freshStore();
  const envelope = await buildHeldSendEnvelope(makeDeps(store), caller, pendingApproval());
  const pendingKeys = Object.keys(pendingPayload({ send_at: "x" }));
  assertEquals(
    Object.keys(envelope).filter((key) => pendingKeys.includes(key)),
    [],
    "no key appears on both sides",
  );

  const sc = heldSendToolResult(pendingPayload(), envelope).structuredContent;
  assertEquals(
    Object.keys(sc).length,
    PENDING_KEYS.length + Object.keys(envelope).length,
    "the merge is a strict superset, losing nothing",
  );
});

Deno.test("a held send does not put the body in model context (contract §7)", async () => {
  // The whole reason this path writes both channels by hand instead of calling
  // index.ts#jsonOk, which would mirror the envelope into `content` too.
  const store = freshStore();
  const envelope = await buildHeldSendEnvelope(makeDeps(store), caller, pendingApproval());
  const result = heldSendToolResult(pendingPayload(), envelope);
  const text = result.content.map((part) => part.text).join("\n");

  assert(!text.includes("SENTINEL-BODY-TEXT"), "the plain-text body must not be in content");
  assert(!text.includes("SENTINEL-BODY-HTML"), "the HTML body must not be in content");
  assert(!text.includes("hidden@x.com"), "bcc must not be in content");
  assert(!text.includes("schema_version"), "the envelope is not mirrored into content");
  // The body IS in the card channel. That is the point of the change.
  assert(
    JSON.stringify(result.structuredContent).includes("SENTINEL-BODY-TEXT"),
    "the card still gets the body it exists to show",
  );
  // …and the model still gets actionable prose (contract §1 degradation rule).
  assert(text.includes(APPROVAL_ID), "the review link is the actionable part");
  assert(text.includes("pending_approval"), "the status a scripted client reads");
});

Deno.test("draft_send hands the card no body at all", async () => {
  // Not a judgement call about disclosure: a draft's content lives with the
  // provider, so the snapshot holds a draft_id and nothing to show. Pinned so a
  // future change that starts snapshotting draft bodies has to come back and
  // think about contract §7 rather than inheriting a pass.
  const store = freshStore({
    operation: "draft_send",
    payload: {
      v: 1,
      data: CIPHER_PREFIX + JSON.stringify({ draft_id: "r-99", body: SECRET_BODY }),
    },
  });
  const envelope = await buildHeldSendEnvelope(
    makeDeps(store),
    caller,
    store.send_approvals[0],
  );
  const outbound = (envelope as Row).outbound as Row;
  assertEquals(outbound.operation, "draft_send", "operation");
  assertEquals(outbound.body.text, null, "no body text");
  assertEquals(outbound.body.html, null, "no body html");
  assert(
    !JSON.stringify(envelope).includes("SENTINEL-BODY-TEXT"),
    "nothing from the snapshot body leaks into the envelope",
  );
});

Deno.test("an envelope that cannot be built degrades to exactly the old payload", async () => {
  // The approval row is already written by the time the envelope is built, and
  // every call site sits inside a catch that reports "no email was sent". A
  // failure here must therefore be invisible, not fatal.
  const payload = pendingPayload();
  const result = heldSendToolResult(payload, null);
  assertEquals(result.structuredContent, payload, "the pre-card payload, unchanged");
  assertEquals(
    result.content[0].text,
    JSON.stringify(payload, null, 2),
    "the pre-card content text, unchanged",
  );
});

Deno.test("the review URL carries a bare id and no credential", () => {
  // Deliberate: a signed URL sitting in model context would itself be a bearer
  // capability. Authentication does the work instead.
  const url = approvalReviewUrl("https://mcpemails.com", APPROVAL_ID);
  assertEquals(url, `https://mcpemails.com/approvals/${APPROVAL_ID}`, "url");
  assert(!url.includes("?"), "no query string");
  for (const secret of ["token", "sig", "key", "hmac", "expires"]) {
    assert(!url.includes(secret), `must not carry a ${secret}`);
  }
});

Deno.test("bcc addresses are counted, never returned", async () => {
  const store = freshStore();
  const result = await runApprovalReview(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
  });
  assertEquals(envelopeOf(result).outbound.recipients.bcc_count, 1, "bcc_count");
  assert(
    !JSON.stringify(result).includes("hidden@x.com"),
    "a bcc address must never appear in a result",
  );
});

Deno.test("the model-visible content omits the body (contract §7)", async () => {
  // Context hygiene, not a boundary: the model can call approval_review itself.
  // What this buys is that the normal flow does not re-inject the message into
  // the conversation.
  const store = freshStore();
  const result = await runApprovalReview(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
  });
  const text = result.result.content.map((part) => part.text).join("\n");
  assert(!text.includes("SENTINEL-BODY-TEXT"), "the plain-text body must not be in content");
  assert(!text.includes("SENTINEL-BODY-HTML"), "the HTML body must not be in content");
  assert(!text.includes("hidden@x.com"), "bcc must not be in content");
  // …while still being meaningful prose for a non-UI client (contract §1).
  assert(text.includes("a@x.com"), "the recipient a caller already knows is fine");
  assert(text.includes(APPROVAL_ID), "the review link is the actionable part");
});

Deno.test("an oversized body is clipped at 64 KB and flagged", async () => {
  const huge = "x".repeat(70 * 1024);
  const store = freshStore({
    payload: { v: 1, data: CIPHER_PREFIX + JSON.stringify({ ...SNAPSHOT, body: huge }) },
  });
  const result = await runApprovalReview(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
  });
  const body = envelopeOf(result).outbound.body;
  assertEquals(body.truncated, true, "truncated flag");
  assert(body.text.length <= 64 * 1024, "clipped");

  // Clipping must not split a multi-byte character into a replacement char.
  const multibyte = clipBody("é".repeat(40_000));
  assertEquals(multibyte.truncated, true, "multibyte truncated");
  assert(!multibyte.value!.includes("�"), "no replacement character");
  assertEquals(clipBody("short").truncated, false, "short bodies pass through");
  assertEquals(clipBody(undefined).value, null, "missing body");
});

// ---------------------------------------------------------------------------
// approval_decide — the reject path
// ---------------------------------------------------------------------------

Deno.test("reject records the decision with its MCP provenance", async () => {
  const store = freshStore();
  const result = await runApprovalDecide(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    decision: "reject",
    note: "Not something we would send.",
  });

  const envelope = envelopeOf(result);
  assertEquals(envelope.card, "receipt", "card");
  assertEquals(envelope.state, "rejected", "state");
  assertEquals(envelope.receipt.outcome, "rejected", "outcome");
  assertEquals(result.logStatus, "success", "a rejection is a successful call");

  const row = store.send_approvals[0];
  assertEquals(row.status, "rejected", "status");
  assertEquals(row.decided_via, "mcp_app", "surface");
  assertEquals(row.decided_by_api_key_id, KEY, "the deciding key");
  assertEquals(row.decided_by, undefined, "no user may be credited for an MCP decision");
  assertEquals(row.decision_note, "Not something we would send.", "note");
});

Deno.test("an over-long note is refused rather than truncated", async () => {
  const store = freshStore();
  const result = await runApprovalDecide(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    decision: "reject",
    note: "x".repeat(501),
  });
  assertEquals(envelopeOf(result).receipt.error_code, "invalid_arguments", "refused");
  assertEquals(store.send_approvals[0].status, "pending", "unchanged");
});

// ---------------------------------------------------------------------------
// approval_update
// ---------------------------------------------------------------------------

Deno.test("approval_update re-encrypts the snapshot AND refreshes the summary", async () => {
  // The summary is what the dashboard queue and the approve page render.
  // Leaving it stale would show the reviewer the old subject for a message
  // whose content had since changed — the exact failure this feature prevents.
  const store = freshStore();
  const result = await runApprovalUpdate(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    subject: "Edited subject",
    body_text: "Edited body",
    body_html: "<p>Edited</p>",
  });

  const row = store.send_approvals[0];
  assertEquals(row.summary.subject, "Edited subject", "summary subject refreshed");
  assertEquals(row.summary.to, ["a@x.com"], "recipients preserved");
  assertEquals(row.summary.bcc_count, 1, "bcc count preserved");
  assertEquals(row.summary.attachment_count, 1, "attachment count preserved");
  assertEquals(row.payload_encrypted, true, "still encrypted at rest");

  const stored = JSON.parse(String(row.payload.data).slice(CIPHER_PREFIX.length));
  assertEquals(stored.subject, "Edited subject", "snapshot subject");
  assertEquals(stored.body, "Edited body", "snapshot body");
  assertEquals(stored.html_body, "<p>Edited</p>", "snapshot html");
  assertEquals(stored.to, ["a@x.com"], "untouched fields survive");
  assertEquals(stored.attachments.length, 1, "attachments survive");

  // And the refreshed envelope comes back, still pending.
  const envelope = envelopeOf(result);
  assertEquals(envelope.card, "outbound_review", "card");
  assertEquals(envelope.state, "pending", "an edit does not decide anything");
  assertEquals(envelope.outbound.subject, "Edited subject", "envelope subject");
  assertEquals(envelope.outbound.body.text, "Edited body", "envelope body");
});

Deno.test("summaryFromSnapshot never emits a recipient it was not given", () => {
  assertEquals(
    summaryFromSnapshot({}),
    { to: [], cc: [], bcc_count: 0, subject: "", attachment_count: 0 },
    "empty snapshot",
  );
  assertEquals(
    summaryFromSnapshot({ to: ["a@x.com", 42, null], bcc: ["a", "b"], subject: 7 }),
    { to: ["a@x.com"], cc: [], bcc_count: 2, subject: "", attachment_count: 0 },
    "junk is dropped, not coerced",
  );
});

// ---------------------------------------------------------------------------
// The summary a reviewer actually reads
// ---------------------------------------------------------------------------

Deno.test("summaryIsComplete separates the operations that need a provider read", () => {
  // email_send / schedule_create: everything is already in the payload.
  assert(
    summaryIsComplete({ to: ["a@x.com"], subject: "Q3 numbers" }),
    "a send carries its own recipients and subject",
  );
  // email_forward: recipients yes, subject no ("Fwd: <original>").
  assert(
    !summaryIsComplete({ to: ["a@x.com"], message_id: "m1" }),
    "a forward still needs its subject resolved",
  );
  // email_reply: neither.
  assert(!summaryIsComplete({ message_id: "m1" }), "a reply needs both");
  // draft_send: nothing but an id.
  assert(!summaryIsComplete({ draft_id: "d1" }), "a draft send needs both");
  // Present-but-empty is not "carried".
  assert(!summaryIsComplete({ to: [], subject: "" }), "empty values do not count");
});

Deno.test("a reply/forward/draft_send summary is populated, not blank", () => {
  // THE BUG THIS GUARDS. These three operations store no recipients and/or no
  // subject, so the dashboard used to show a reviewer a blank To and a blank
  // Subject and ask them to approve it anyway. Values resolved from the
  // provider fill the gap.
  assertEquals(
    buildApprovalSummary(
      { message_id: "m1", body: "sure, sounds good" },
      { to: ["Ada Lovelace <ada@x.com>"], subject: "Re: Q3 numbers" },
    ),
    {
      to: ["Ada Lovelace <ada@x.com>"],
      cc: [],
      bcc_count: 0,
      subject: "Re: Q3 numbers",
      attachment_count: 0,
    },
    "email_reply",
  );
  assertEquals(
    buildApprovalSummary(
      { message_id: "m1", to: ["bob@x.com"] },
      { subject: "Fwd: Q3 numbers" },
    ),
    { to: ["bob@x.com"], cc: [], bcc_count: 0, subject: "Fwd: Q3 numbers", attachment_count: 0 },
    "email_forward keeps its own recipients and takes the resolved subject",
  );
  assertEquals(
    buildApprovalSummary(
      { draft_id: "d1" },
      { to: ["ada@x.com"], cc: ["carol@x.com"], bcc_count: 2, subject: "Draft subject" },
    ),
    {
      to: ["ada@x.com"],
      cc: ["carol@x.com"],
      bcc_count: 2,
      subject: "Draft subject",
      attachment_count: 0,
    },
    "draft_send takes everything from the provider draft",
  );
});

Deno.test("the payload always outranks a resolved value", () => {
  // What is stored is what will be transmitted. A derived value may never
  // override it, or the reviewer approves one thing and another is sent.
  assertEquals(
    buildApprovalSummary(
      { to: ["real@x.com"], subject: "Real subject", bcc: ["h@x.com"] },
      { to: ["derived@x.com"], subject: "Derived subject", bcc_count: 99 },
    ),
    {
      to: ["real@x.com"],
      cc: [],
      bcc_count: 1,
      subject: "Real subject",
      attachment_count: 0,
    },
    "resolution fills gaps only",
  );
});

Deno.test("a failed provider resolution degrades to today's blank summary", () => {
  // resolveApprovalSummaryFields returns {} on any provider error, and the
  // queue must still succeed: the alternative is refusing to accept a send that
  // the caller is entitled to make.
  assertEquals(
    buildApprovalSummary({ message_id: "m1", body: "hi" }, {}),
    { to: [], cc: [], bcc_count: 0, subject: "", attachment_count: 0 },
    "blank, but not an error",
  );
});

Deno.test("a summary is neutralised before it is stored", () => {
  // The subject and the display name come from inbound mail. U+202E in either
  // makes the dashboard queue, the approve page and the audit log render
  // something other than what will be sent.
  const summary = buildApprovalSummary(
    { subject: `Invoice ${RLO}FDP.exe`, to: [`Accounts ${RLO}<evil@x.com>`] },
    {},
  );
  assert(
    !JSON.stringify(summary).includes(RLO),
    "no bidi override reaches storage",
  );
  assertEquals(summary.subject, "Invoice FDP.exe", "subject");
  assertEquals(summary.to, ["Accounts <evil@x.com>"], "recipient label");
});

Deno.test("a body-only edit does not blank a reply's resolved recipients", () => {
  // Regression guard for the interaction between the two fixes: a reply's
  // snapshot has no `to` and no `subject`, so recomputing the summary from the
  // snapshot alone after an unrelated body edit would silently undo the
  // queue-time resolution and put the reviewer back in front of a blank line.
  const previous = {
    to: ["ada@x.com"],
    cc: ["carol@x.com"],
    bcc_count: 1,
    subject: "Re: Q3 numbers",
    attachment_count: 0,
  };
  assertEquals(
    summaryFromSnapshot({ message_id: "m1", body: "edited body" }, previous),
    previous,
    "resolved values survive an edit that did not touch them",
  );
  // But an actual edit still wins.
  assertEquals(
    summaryFromSnapshot({ to: ["new@x.com"], subject: "New", body: "b" }, previous).subject,
    "New",
    "an edited subject replaces the previous one",
  );
});

Deno.test("approval_update preserves a reply's resolved summary end to end", async () => {
  // Same property, through the real handler rather than the helper. A reply
  // snapshot carries no recipients; the row's summary does.
  const store = freshStore({
    operation: "email_reply",
    payload: {
      v: 1,
      data: CIPHER_PREFIX + JSON.stringify({ message_id: "m1", body: "original" }),
    },
    summary: {
      to: ["ada@x.com"],
      cc: [],
      bcc_count: 0,
      subject: "Re: Q3 numbers",
      attachment_count: 0,
    },
  });
  await runApprovalUpdate(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    body_text: "edited reply body",
  });
  const row = store.send_approvals[0];
  assertEquals(row.summary.to, ["ada@x.com"], "recipients survive the edit");
  assertEquals(row.summary.subject, "Re: Q3 numbers", "subject survives the edit");
});

Deno.test("the outbound envelope neutralises every field a reviewer scans", async () => {
  // The card runs its own neutralizeDeep on ingest, but the envelope is also
  // read by anything else that speaks the contract, and the server should not
  // be emitting spoofable strings in the first place.
  const store = freshStore({
    summary: {
      to: [`Accounts ${RLO}<evil@x.com>`],
      cc: [],
      bcc_count: 0,
      subject: `Invoice ${RLO}FDP.exe`,
      attachment_count: 1,
    },
    payload: {
      v: 1,
      data: CIPHER_PREFIX + JSON.stringify({
        ...SNAPSHOT,
        attachments: [{
          filename: `invoice${RLO} fdp.exe`,
          mime_type: "application/pdf",
          data: "AAAA",
        }],
      }),
    },
  });
  store.inboxes = [inboxRow({ display_name: `Finance ${RLO}Team` })];
  // A DIFFERENT key queued this send, so the name is read from the database
  // rather than short-circuited from the caller.
  const OTHER_KEY = "88888888-8888-4888-8888-888888888888";
  store.send_approvals[0].api_key_id = OTHER_KEY;
  store.api_keys = [{ id: OTHER_KEY, name: `Claude ${RLO}Desktop` }];
  store.mcp_client_capabilities = [
    { api_key_id: OTHER_KEY, client_name: `claude${RLO}-ai` },
  ];

  const envelope = envelopeOf(
    await runApprovalReview(makeDeps(store), caller, { approval_id: APPROVAL_ID }),
  );
  const outbound = envelope.outbound;

  assertEquals(outbound.subject, "Invoice FDP.exe", "subject");
  assertEquals(outbound.recipients.to, ["Accounts <evil@x.com>"], "recipients");
  assertEquals(outbound.identity.display_name, "Finance Team", "inbox display name");
  assertEquals(outbound.attachments[0].filename, "invoice fdp.exe", "attachment filename");
  assertEquals(outbound.requested_by.api_key_name, "Claude Desktop", "requesting key name");
  assertEquals(outbound.requested_by.client_name, "claude-ai", "requesting client name");
  assert(
    !JSON.stringify({ ...outbound, body: null }).includes(RLO),
    "no bidi override anywhere outside the body",
  );
});

Deno.test("the message BODY is deliberately left alone", () => {
  // Bidi controls are legitimate in Hebrew, Arabic, Persian and Urdu prose.
  // Stripping them from a body would corrupt mail we are only meant to show,
  // and a body is read as a block of untrusted text rather than scanned as a
  // structural field. Documented here so a future change has to argue with it.
  const bodyWithBidi = `\u202bمرحبا\u202c and back to English`;
  assertEquals(
    clipBody(bodyWithBidi).value,
    bodyWithBidi,
    "clipBody is the only thing that touches a body, and it only clips",
  );
});

Deno.test("approval_update refuses edits that would silently do nothing", async () => {
  // A draft_send approval stores a draft id; the message lives with the
  // provider and is sent verbatim.
  const draft = freshStore({ operation: "draft_send" });
  assertEquals(
    envelopeOf(
      await runApprovalUpdate(makeDeps(draft), caller, {
        approval_id: APPROVAL_ID,
        body_text: "no effect",
      }),
    ).receipt.error_code,
    "not_editable",
    "draft_send is not editable",
  );

  // Replies and forwards derive their subject from the original message.
  const reply = freshStore({ operation: "email_reply" });
  assertEquals(
    envelopeOf(
      await runApprovalUpdate(makeDeps(reply), caller, {
        approval_id: APPROVAL_ID,
        subject: "Re: something else",
      }),
    ).receipt.error_code,
    "invalid_arguments",
    "subject on a reply is refused",
  );

  // …but its body is editable.
  const replyBody = await runApprovalUpdate(makeDeps(reply), caller, {
    approval_id: APPROVAL_ID,
    body_text: "Edited reply",
  });
  assertEquals(envelopeOf(replyBody).card, "outbound_review", "reply body edit accepted");

  // An empty edit is a client bug, not a no-op.
  assertEquals(
    envelopeOf(await runApprovalUpdate(makeDeps(freshStore()), caller, { approval_id: APPROVAL_ID }))
      .receipt.error_code,
    "invalid_arguments",
    "an edit with no fields is refused",
  );
});

// ---------------------------------------------------------------------------
// approval_schedule
// ---------------------------------------------------------------------------

Deno.test("approval_schedule sets a future send_at and nothing else", async () => {
  const store = freshStore();
  const result = await runApprovalSchedule(makeDeps(store), caller, {
    approval_id: APPROVAL_ID,
    send_at: "2026-08-05T18:00:00.000Z",
  });

  assertEquals(store.send_approvals[0].send_at, "2026-08-05T18:00:00.000Z", "send_at stored");
  assertEquals(store.send_approvals[0].status, "pending", "scheduling decides nothing");

  const envelope = envelopeOf(result);
  assertEquals(envelope.outbound.send_at, "2026-08-05T18:00:00.000Z", "envelope send_at");
  // Not "scheduled": nothing is queued for delivery until a human approves.
  assertEquals(envelope.state, "pending", "state stays pending");
});

Deno.test("approval_schedule refuses a past or unparseable timestamp", async () => {
  for (
    const send_at of [
      "2026-08-05T11:59:00.000Z", // one minute ago
      "2026-08-05T12:00:00.000Z", // exactly now
      "yesterday",
      "",
      12345,
    ]
  ) {
    const store = freshStore();
    const result = await runApprovalSchedule(makeDeps(store), caller, {
      approval_id: APPROVAL_ID,
      send_at,
    });
    assertEquals(
      envelopeOf(result).receipt.error_code,
      "invalid_arguments",
      `refused: ${String(send_at)}`,
    );
    assertEquals(store.send_approvals[0].send_at, null, "unchanged");
  }
});

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

Deno.test("the approval tools are scoped to send:email, with schedule:email accepted", () => {
  // They act on a pending outbound send, so send:email — the consent that
  // produced the approval — is the fit. schedule_create is gated by
  // schedule:email instead, so a key holding only that must still be able to
  // review and withdraw what it queued.
  for (const tool of APPROVAL_TOOL_DEFINITIONS) {
    assertEquals(tool.requiredScope, "send:email", `${tool.name} scope`);
    assertEquals(tool.altScopes, ["schedule:email"], `${tool.name} altScopes`);
    assertEquals(
      (tool.inputSchema as Record<string, unknown>).additionalProperties,
      false,
      `${tool.name} rejects unknown arguments`,
    );
    assert(
      Array.isArray((tool.inputSchema as Record<string, unknown>).required) &&
        ((tool.inputSchema as Record<string, any>).required as string[]).includes("approval_id"),
      `${tool.name} requires approval_id`,
    );

    // The outputSchema is deliberately the mirror image of the inputSchema
    // above: arguments are refused unless known, results are accepted whatever
    // they carry. A declared output schema is a MUST under the spec ("servers
    // MUST provide structured results that conform"), and each card merges a
    // per-tool payload into the shared envelope, so a strict schema would
    // reject real results as soon as a payload key changed. Permissive is what
    // makes declaring it safe.
    const out = tool.outputSchema as Record<string, unknown> | undefined;
    assert(out !== undefined, `${tool.name} must declare an outputSchema`);
    assertEquals(out!.type, "object", `${tool.name} outputSchema is an object`);
    assertEquals(
      out!.additionalProperties,
      true,
      `${tool.name} outputSchema must stay permissive`,
    );
    assertEquals(out!.required, undefined, `${tool.name} outputSchema must require no key`);
  }
  assertEquals(
    APPROVAL_TOOL_DEFINITIONS.map((t) => t.name),
    [...APPROVAL_TOOL_NAMES],
    "definitions match the exported name list",
  );
  assert(isApprovalToolName("approval_decide"), "name predicate");
  assert(!isApprovalToolName("email_send"), "predicate does not over-match");
});

Deno.test("approval tools are absent from the billable surface", () => {
  // Mirrors BILLABLE_TOOL_NAMES in index.ts: they act on an approval, not on an
  // inbox's mail. Kept as a literal here because index.ts cannot be imported.
  const billable = new Set([
    "contact_search", "draft_create", "draft_delete", "draft_list", "draft_reply",
    "draft_send", "draft_update", "email_archive", "email_attachment", "email_copy",
    "email_copy_batch", "email_delete", "email_delete_batch", "email_extract",
    "email_flag", "email_forward", "email_list", "email_move", "email_move_batch",
    "email_original", "email_read", "email_read_batch", "email_reply", "email_search",
    "email_search_and_delete", "email_search_and_move", "email_send", "folder_create",
    "folder_delete", "folder_list", "folder_rename", "schedule_cancel", "schedule_create",
    "schedule_list", "signature_get", "signature_set",
  ]);
  for (const name of APPROVAL_TOOL_NAMES) {
    assert(!billable.has(name), `${name} must be non-billable`);
  }
});

// ---------------------------------------------------------------------------
// Migration-order tolerance
// ---------------------------------------------------------------------------

Deno.test("writes degrade when the Phase 2 columns do not exist yet", async () => {
  // The edge function is deployed by hand; a deploy that lands before the
  // migration must not 500 every gated send. Delete this test with the shim.
  const store = freshStore();
  const deps = makeDeps(store, {
    missingColumns: ["decided_via", "decided_by_api_key_id", "expires_at"],
  });
  const result = await runApprovalDecide(deps, caller, {
    approval_id: APPROVAL_ID,
    decision: "reject",
  });

  assertEquals(envelopeOf(result).state, "rejected", "the rejection still lands");
  assertEquals(store.send_approvals[0].status, "rejected", "status written");
  assertEquals(store.send_approvals[0].decided_via, null, "the unknown column was dropped");

  // The retry is exact: nothing else is silently dropped along with it.
  const attempted: Array<Record<string, unknown>> = [];
  const outcome = await writeTolerantly<null>(
    { status: "rejected", decided_via: "mcp_app" },
    ["decided_via"],
    (patch) => {
      attempted.push(patch);
      return Promise.resolve(
        "decided_via" in patch
          ? { data: null, error: { code: "42703", message: "column decided_via does not exist" } }
          : { data: null, error: null },
      );
    },
  );
  assertEquals(attempted.length, 2, "one retry");
  assertEquals(attempted[1], { status: "rejected" }, "only the optional column is dropped");
  assertEquals(outcome.error, null, "and the retry succeeds");
});
