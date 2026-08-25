// ---------------------------------------------------------------------------
// Unattended triage engine tests.
//
// The properties under test are the ones that decide whether it is safe to let
// this thing touch a mailbox with nobody watching:
//
//   * the dedupe ledger is consulted BEFORE the action, and a losing claim
//     really does prevent the provider call (not merely record a different
//     outcome afterwards);
//   * a draft_reply template cannot be made to interpolate message body content,
//     and a subject the attacker controls cannot smuggle a second substitution;
//   * delete-shaped actions are refused by name, with an error that says why;
//   * the lease is claimed by compare-and-set, and a stale lease is failed
//     forward rather than re-run.
//
// The engine takes its store and every provider seam as injected dependencies
// (`TriageDeps`), so "what would actually have been done to the mailbox" is
// directly observable here rather than inferred. index.ts cannot be imported by
// a test (it calls Deno.serve and builds a service-role client at module load).
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

// deno-lint-ignore-file no-explicit-any

import { parsePermanentFlags } from "./imap-client.ts";
import {
  labelTargetFor,
  MAX_IMAP_KEYWORD_CHARS,
  mergeOutlookCategories,
  normalizeImapKeyword,
  permanentFlagsAllowKeyword,
} from "./label-target.ts";
import {
  checkTriageAuthority,
  handleTriageDispatch,
  redactForRunLog,
  renderTriageTemplate,
  runTriageRule,
  TRIAGE_MAX_FORWARD_RECIPIENTS,
  TRIAGE_STALE_LEASE_MS,
  type TriageActionOutcome,
  type TriageApiKey,
  type TriageDeps,
  type TriageInbox,
  type TriageKeyGrant,
  type TriageMatch,
  type TriageRuleRow,
  type TriageStore,
  validateTriageAction,
  validateTriageFilter,
  validateTriageInterval,
  validateTriageMaxMessages,
} from "./triage-engine.ts";

/** U+202E RIGHT-TO-LEFT OVERRIDE - see text-safety.test.ts. */
const RLO = "‮";

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
// A recording fake store
//
// Faithful where it matters: `claimMessage` really does hold a set and really
// does return false the second time, and `claimRule` really does refuse a rule
// whose lease is already held. Those two are the whole safety story.
// ---------------------------------------------------------------------------

interface FakeState {
  seen: Set<string>;
  leases: Map<string, string>;
  runs: any[];
  runItems: any[];
  released: any[];
  reclaimed: string[];
  staleLeases: { id: string }[];
  dueRules: TriageRuleRow[];
  apiKey: TriageApiKey | null;
  /** What loadKeyGrant answers. Null = no OAuth chain references this key. */
  keyGrant: TriageKeyGrant | null;
  inbox: TriageInbox | null;
}

function freshState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    seen: new Set(),
    leases: new Map(),
    runs: [],
    runItems: [],
    released: [],
    reclaimed: [],
    staleLeases: [],
    dueRules: [],
    apiKey: {
      id: "key-1",
      workspace_id: "ws-1",
      name: "Automations key",
      scopes: ["read:email", "manage:folders", "manage:drafts", "send:email"],
      inbox_ids: null,
      expires_at: null,
      deleted_at: null,
    },
    keyGrant: null,
    inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@b.com", provider: "gmail" },
    ...overrides,
  };
}

function fakeStore(state: FakeState): TriageStore {
  return {
    listStaleLeases: () => Promise.resolve(state.staleLeases),
    reclaimStaleLease: (ruleId) => {
      state.reclaimed.push(ruleId);
      state.leases.delete(ruleId);
      return Promise.resolve();
    },
    listDueRules: () => Promise.resolve(state.dueRules),
    claimRule: (ruleId, nowIso) => {
      // The CAS: a rule whose lease is already held cannot be claimed again.
      if (state.leases.has(ruleId)) return Promise.resolve(false);
      state.leases.set(ruleId, nowIso);
      return Promise.resolve(true);
    },
    releaseRule: (ruleId, update) => {
      state.leases.delete(ruleId);
      state.released.push({ ruleId, ...update });
      return Promise.resolve();
    },
    createRun: (input) => {
      const id = `run-${state.runs.length + 1}`;
      state.runs.push({ id, status: "running", ...input });
      return Promise.resolve(id);
    },
    finishRun: (runId, update) => {
      const run = state.runs.find((r) => r.id === runId);
      if (run) Object.assign(run, update);
      return Promise.resolve();
    },
    claimMessage: (ruleId, digest) => {
      const composite = `${ruleId}:${digest}`;
      if (state.seen.has(composite)) return Promise.resolve(false);
      state.seen.add(composite);
      return Promise.resolve(true);
    },
    writeRunItem: (input) => {
      state.runItems.push(input);
      return Promise.resolve();
    },
    loadApiKey: () => Promise.resolve(state.apiKey),
    loadKeyGrant: () => Promise.resolve(state.keyGrant),
    loadInbox: () => Promise.resolve(state.inbox),
  };
}

/** A store from before rotation-following existed: no loadKeyGrant at all. */
function storeWithoutGrantLookup(state: FakeState): TriageStore {
  const store = { ...fakeStore(state) };
  delete (store as { loadKeyGrant?: unknown }).loadKeyGrant;
  return store;
}

function fakeRule(overrides: Partial<TriageRuleRow> = {}): TriageRuleRow {
  return {
    id: "rule-1",
    workspace_id: "ws-1",
    inbox_id: "inbox-1",
    api_key_id: "key-1",
    name: "Archive newsletters",
    enabled: true,
    filter: { from: "news@example.com" },
    action: { type: "move", folder: "Newsletters" },
    interval_minutes: 60,
    max_messages_per_run: 25,
    next_run_at: new Date(0).toISOString(),
    running_since: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

function fakeMatch(id: string, overrides: Partial<TriageMatch> = {}): TriageMatch {
  return {
    id,
    subject: "Weekly digest",
    from_name: "News Desk",
    from_email: "news@example.com",
    date: "2026-08-19T09:00:00Z",
    folder: "INBOX",
    ...overrides,
  };
}

/** Records every applyAction call so a test can assert the mailbox was untouched. */
function fakeDeps(
  state: FakeState,
  matches: TriageMatch[],
  applied: { calls: any[] },
  outcome: TriageActionOutcome = { ok: true, undo: { op: "move" } },
): TriageDeps {
  return {
    store: fakeStore(state),
    digest: (id) => Promise.resolve(`digest-${id}`),
    encrypt: (text) => Promise.resolve(`enc(${text})`),
    search: () => Promise.resolve(matches),
    resolveFolder: (_inbox, name) => Promise.resolve(`id-of-${name}`),
    applyAction: (input) => {
      applied.calls.push(input);
      return Promise.resolve(outcome);
    },
    meter: () => Promise.resolve(),
    now: () => 1_000_000,
  };
}

// ---------------------------------------------------------------------------
// The dedupe ledger
// ---------------------------------------------------------------------------

Deno.test("a message already in the seen ledger is skipped and never acted on", async () => {
  const state = freshState();
  // Pre-claim the message, as an earlier (or overlapping) run would have.
  state.seen.add("rule-1:digest-msg-a");
  const applied = { calls: [] as any[] };
  const deps = fakeDeps(state, [fakeMatch("msg-a"), fakeMatch("msg-b")], applied);

  const summary = await runTriageRule(deps, fakeRule());

  assertEquals(summary.skipped, 1, "the pre-claimed message counts as skipped");
  assertEquals(summary.processed, 1, "only the unclaimed message is processed");
  assertEquals(applied.calls.length, 1, "the provider is called exactly once");
  assertEquals(
    applied.calls[0].match.id,
    "msg-b",
    "the mailbox is touched ONLY for the message this run actually claimed",
  );

  const skippedItem = state.runItems.find((i) => i.outcome === "skipped_duplicate");
  assert(!!skippedItem, "a skipped_duplicate run item is recorded, not silently dropped");
  assertEquals(skippedItem.message_digest, "digest-msg-a", "the skip names the right message");
});

Deno.test("re-running the same rule over the same mail acts zero further times", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  const matches = [fakeMatch("msg-a"), fakeMatch("msg-b")];

  const first = await runTriageRule(fakeDeps(state, matches, applied), fakeRule());
  assertEquals(first.succeeded, 2, "the first run acts on both messages");

  // The state (and therefore the ledger) is deliberately carried over: this is
  // the re-dispatch case that would otherwise move the same mail twice.
  const second = await runTriageRule(fakeDeps(state, matches, applied), fakeRule());
  assertEquals(second.skipped, 2, "the second run skips both");
  assertEquals(second.processed, 0, "the second run processes nothing");
  assertEquals(applied.calls.length, 2, "the provider was still only ever called twice in total");
});

Deno.test("a run whose matches are all duplicates is 'skipped', not 'completed'", async () => {
  const state = freshState();
  state.seen.add("rule-1:digest-msg-a");
  const applied = { calls: [] as any[] };
  const summary = await runTriageRule(fakeDeps(state, [fakeMatch("msg-a")], applied), fakeRule());
  assertEquals(summary.status, "skipped", "a rule that only ever skips is visibly distinct");
});

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

Deno.test("the template substitutes only the four whitelisted placeholders", () => {
  const rendered = renderTriageTemplate(
    "Hi {{sender_name}} <{{sender_email}}>, re {{subject}} on {{date}}.",
    {
      sender_name: "News Desk",
      sender_email: "news@example.com",
      subject: "Weekly digest",
      date: "2026-08-19",
    },
  );
  assertEquals(
    rendered,
    // The angle brackets here are the TEMPLATE's own literal text and survive
    // untouched. Only substituted VALUES are escaped, which the escaping test
    // below covers.
    "Hi News Desk <news@example.com>, re Weekly digest on 2026-08-19.",
    "all four placeholders substitute",
  );
});

Deno.test("a template cannot reach message body content", () => {
  const ctx = {
    sender_name: "News Desk",
    sender_email: "news@example.com",
    subject: "Weekly digest",
    date: "2026-08-19",
  };
  // Every plausible spelling an author (or an attacker editing a rule) might try.
  for (
    const attempt of [
      "{{body}}",
      "{{ body }}",
      "{{body_text}}",
      "{{message.body}}",
      "{{preview}}",
      "{{snippet}}",
      "{{ context.body }}",
    ]
  ) {
    const rendered = renderTriageTemplate(`Quote: ${attempt}`, ctx as any);
    assert(
      rendered === `Quote: ${attempt}`,
      `an unknown placeholder must stay literal, got: ${rendered}`,
    );
  }
});

Deno.test("a template performs no expression evaluation", () => {
  const ctx = {
    sender_name: "X",
    sender_email: "x@y.z",
    subject: "S",
    date: "D",
  };
  const rendered = renderTriageTemplate("{{1+1}} {{subject.length}} {{constructor}}", ctx);
  assertEquals(
    rendered,
    "{{1+1}} {{subject.length}} {{constructor}}",
    "nothing but a bare whitelisted name is ever evaluated",
  );
});

Deno.test("an attacker-controlled subject cannot smuggle a second substitution", () => {
  // The subject is fully attacker-controlled: anyone who can email the user
  // chooses it. If substitution re-scanned its own output, this subject would
  // expand a second time.
  const rendered = renderTriageTemplate("Subject was: {{subject}}", {
    sender_name: "Mallory",
    sender_email: "m@evil.test",
    subject: "{{sender_email}}",
    date: "2026-08-19",
  });
  assertEquals(
    rendered,
    "Subject was: {{sender_email}}",
    "substitution is single-pass, so a crafted subject is inert text",
  );
});

Deno.test("substituted values are HTML-escaped and neutralized", () => {
  const rendered = renderTriageTemplate("From {{sender_name}}", {
    sender_name: `<script>alert(1)</script>${RLO}`,
    sender_email: "x@y.z",
    subject: "s",
    date: "d",
  });
  assert(!rendered.includes("<script>"), "HTML is escaped");
  assert(!rendered.includes(RLO), "bidi overrides are stripped from a display name");
});

// ---------------------------------------------------------------------------
// Delete is not an available action
// ---------------------------------------------------------------------------

Deno.test("delete-shaped actions are refused by name, with a reason", () => {
  for (
    const type of [
      "delete",
      "Delete",
      "DELETE",
      "trash",
      "purge",
      "remove",
      "destroy",
      "expunge",
      "erase",
      "permanent_delete",
      "delete_batch",
      "search_and_delete",
      "empty_trash",
    ]
  ) {
    const result = validateTriageAction({ type });
    assert(!result.ok, `action.type '${type}' must be refused`);
    assert(
      (result as { error: string }).error.includes("Deleting mail"),
      `the refusal for '${type}' must explain the product rule, got: ${(result as any).error}`,
    );
  }
});

Deno.test("a rule with a delete action fails its run without touching the mailbox", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  const deps = fakeDeps(state, [fakeMatch("msg-a")], applied);

  const summary = await runTriageRule(deps, fakeRule({ action: { type: "delete" } }));

  assertEquals(summary.status, "failed", "the run fails");
  assertEquals(summary.error_code, "invalid_action", "and says why");
  assertEquals(applied.calls.length, 0, "nothing whatsoever reached the mailbox");
  assertEquals(state.seen.size, 0, "and no message was claimed in the ledger");
});

Deno.test("only the five documented action types validate", () => {
  assert(validateTriageAction({ type: "move", folder: "X" }).ok, "move validates");
  assert(validateTriageAction({ type: "label", label: "X" }).ok, "label validates");
  assert(validateTriageAction({ type: "mark_read" }).ok, "mark_read validates");
  assert(validateTriageAction({ type: "forward", to: ["a@b.co"] }).ok, "forward validates");
  assert(validateTriageAction({ type: "draft_reply", template: "hi" }).ok, "draft_reply validates");
  assert(!validateTriageAction({ type: "send" }).ok, "an unlisted type is refused");
  assert(!validateTriageAction({ type: "move" }).ok, "move without a folder is refused");
});

Deno.test("forward recipient lists are bounded at both ends", () => {
  assert(!validateTriageAction({ type: "forward", to: [] }).ok, "an empty list is refused");
  const tooMany = Array.from(
    { length: TRIAGE_MAX_FORWARD_RECIPIENTS + 1 },
    (_, i) => `a${i}@b.co`,
  );
  assert(
    !validateTriageAction({ type: "forward", to: tooMany }).ok,
    "more than the cap is refused",
  );
  assert(
    !validateTriageAction({ type: "forward", to: ["not-an-address"] }).ok,
    "an invalid address is refused",
  );
});

Deno.test("templates over the cap are refused", () => {
  const long = "x".repeat(5001);
  assert(!validateTriageAction({ type: "draft_reply", template: long }).ok, "5001 chars is refused");
  assert(validateTriageAction({ type: "draft_reply", template: "x".repeat(5000) }).ok, "5000 is fine");
});

// ---------------------------------------------------------------------------
// Filter, interval and cap validation
// ---------------------------------------------------------------------------

Deno.test("an empty filter is refused", () => {
  const result = validateTriageFilter({});
  assert(!result.ok, "an empty filter matches the whole mailbox and must be refused");
});

Deno.test("a stored filter date must be the same ISO shape the tools accept", () => {
  for (const good of ["2026-08-25", "2026-08-25T09:00", "2026-08-25T09:00:00Z", "2026-08-25T09:00:00+02:00"]) {
    assert(validateTriageFilter({ since: good }).ok, `${good} is a shape the search tools accept`);
  }
  // `Date.parse` used to accept all of these. A rule is re-validated and re-run
  // by a cron, so a zone-less or prose date could select a different day's mail
  // depending on which region the edge function booted in.
  for (const bad of ["June 1 2026", "08/25/2026", "2026-08-25 09:00:00", "2026-13-01", "yesterday", ""]) {
    assert(
      !validateTriageFilter({ since: bad }).ok,
      `${JSON.stringify(bad)} must not be storable as a filter date`,
    );
  }
  assert(!validateTriageFilter({ before: "June 1 2026" }).ok, "both date fields are checked");
});

Deno.test("only ladder intervals are accepted", () => {
  for (const good of [15, 30, 60, 180, 360, 720, 1440]) {
    assert(validateTriageInterval(good).ok, `${good} is on the ladder`);
  }
  for (const bad of [1, 5, 14, 45, 2000, 0, -60, 1.5]) {
    assert(!validateTriageInterval(bad).ok, `${bad} is not on the ladder`);
  }
});

Deno.test("max_messages_per_run is bounded to 1..200", () => {
  assert(validateTriageMaxMessages(1).ok, "1 is allowed");
  assert(validateTriageMaxMessages(200).ok, "200 is allowed");
  assert(!validateTriageMaxMessages(0).ok, "0 is refused");
  assert(!validateTriageMaxMessages(201).ok, "201 is refused");
  assert(!validateTriageMaxMessages(2.5).ok, "a non-integer is refused");
});

Deno.test("the per-run cap really bounds how much mail is touched", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  const many = Array.from({ length: 10 }, (_, i) => fakeMatch(`msg-${i}`));
  await runTriageRule(fakeDeps(state, many, applied), fakeRule({ max_messages_per_run: 3 }));
  assertEquals(applied.calls.length, 3, "the cap is enforced on the act loop, not just the search");
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

Deno.test("two overlapping dispatches cannot both claim the same rule", async () => {
  const state = freshState({ dueRules: [fakeRule()] });
  const applied = { calls: [] as any[] };
  const deps = fakeDeps(state, [fakeMatch("msg-a")], applied);

  const first = await handleTriageDispatch(deps);
  const firstBody = await first.json();
  assertEquals(firstBody.ran, 1, "the first dispatch claims and runs the rule");

  // Simulate the rule still being leased when a second dispatch arrives.
  state.leases.set("rule-1", new Date().toISOString());
  state.dueRules = [fakeRule()];
  const second = await handleTriageDispatch(deps);
  const secondBody = await second.json();
  assertEquals(secondBody.ran, 0, "the second dispatch runs nothing");
  assertEquals(secondBody.contended, 1, "and reports the contention rather than hiding it");
});

Deno.test("a completed run releases the lease and schedules the next", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  await runTriageRule(fakeDeps(state, [fakeMatch("msg-a")], applied), fakeRule({ interval_minutes: 60 }));

  assertEquals(state.released.length, 1, "the lease is released exactly once");
  const release = state.released[0];
  assertEquals(release.consecutive_failures, 0, "a successful run resets the failure counter");
  assertEquals(
    release.next_run_at,
    new Date(1_000_000 + 60 * 60_000).toISOString(),
    "next_run_at is now() + interval_minutes",
  );
  assertEquals(state.leases.size, 0, "no lease is left behind");
});

Deno.test("a stale lease is reclaimed and its run failed forward, never re-run", async () => {
  const state = freshState({ staleLeases: [{ id: "rule-stale" }] });
  state.leases.set("rule-stale", new Date(0).toISOString());
  const applied = { calls: [] as any[] };
  const deps = fakeDeps(state, [], applied);

  const response = await handleTriageDispatch(deps);
  const body = await response.json();

  assertEquals(body.reclaimed, 1, "the stale lease is reclaimed");
  assertEquals(state.reclaimed, ["rule-stale"], "by id");
  assertEquals(
    applied.calls.length,
    0,
    "reclaiming NEVER re-runs the interrupted work: it may have partially applied",
  );
});

Deno.test("the stale-lease window is the documented ten minutes", () => {
  assertEquals(TRIAGE_STALE_LEASE_MS, 10 * 60 * 1000, "matches the migration's stated contract");
});

Deno.test("a failed run increments the counter and auto-disables at five", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  // A rule whose action is invalid fails deterministically.
  const rule = fakeRule({ action: { type: "nonsense" }, consecutive_failures: 4 });
  await runTriageRule(fakeDeps(state, [], applied), rule);

  const release = state.released[0];
  assertEquals(release.consecutive_failures, 5, "the counter increments");
  assertEquals(release.enabled, false, "the rule disables itself at the ceiling");
  assert(
    typeof release.disabled_reason === "string" && release.disabled_reason.length > 0,
    "and says why, so it is explicable in the dashboard",
  );
});

Deno.test("a failing rule below the ceiling stays enabled", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  await runTriageRule(
    fakeDeps(state, [], applied),
    fakeRule({ action: { type: "nonsense" }, consecutive_failures: 1 }),
  );
  const release = state.released[0];
  assertEquals(release.consecutive_failures, 2, "the counter increments");
  assertEquals(release.enabled, undefined, "but nothing disables the rule yet");
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

Deno.test("authority is re-derived at run time, not snapshotted at create time", () => {
  const base: TriageApiKey = {
    id: "key-1",
    workspace_id: "ws-1",
    name: "k",
    scopes: ["manage:folders"],
    inbox_ids: null,
    expires_at: null,
    deleted_at: null,
  };
  const move = { type: "move" as const, folder: "X" };

  assert(checkTriageAuthority(base, "inbox-1", move, Date.now()).ok, "a valid key passes");
  assert(
    !checkTriageAuthority(null, "inbox-1", move, Date.now()).ok,
    "a deleted key fails",
  );
  assert(
    !checkTriageAuthority({ ...base, deleted_at: "2026-01-01" }, "inbox-1", move, Date.now()).ok,
    "a soft-deleted key fails",
  );
  assert(
    !checkTriageAuthority({ ...base, expires_at: "2020-01-01" }, "inbox-1", move, Date.now()).ok,
    "an expired key fails",
  );
  assert(
    !checkTriageAuthority({ ...base, scopes: [] }, "inbox-1", move, Date.now()).ok,
    "a key that lost the scope fails",
  );
  assert(
    !checkTriageAuthority({ ...base, inbox_ids: ["other"] }, "inbox-1", move, Date.now()).ok,
    "a key restricted away from the inbox fails",
  );
});

Deno.test("draft_reply additionally requires read:email", () => {
  const key: TriageApiKey = {
    id: "k",
    workspace_id: "ws-1",
    name: "k",
    scopes: ["manage:drafts"],
    inbox_ids: null,
    expires_at: null,
    deleted_at: null,
  };
  const action = { type: "draft_reply" as const, template: "hi" };
  const result = checkTriageAuthority(key, "inbox-1", action, Date.now());
  assert(!result.ok, "manage:drafts alone is not enough to derive reply recipients");
});

// ---------------------------------------------------------------------------
// Rotation is not revocation
//
// The incident these cover: an OAuth-issued api_keys row IS the connection, and
// the refresh grant rotates that row in place with a new one-hour expiry. A
// cron running an hour after the user's last Claude session therefore saw
// `expires_at` in the past and failed a live connection as "expired", once an
// hour, for days. What must NOT change is that a real withdrawal of authority
// still stops the rule on its next run.
// ---------------------------------------------------------------------------

const EXPIRED_KEY: TriageApiKey = {
  id: "key-1",
  workspace_id: "ws-1",
  name: "OAuth: Claude",
  scopes: ["manage:folders"],
  inbox_ids: null,
  // An hour before the fake clock: exactly what a key looks like when the
  // client has not refreshed since the user's last session.
  expires_at: new Date(1_000_000 - 3_600_000).toISOString(),
  deleted_at: null,
};

const LIVE_GRANT: TriageKeyGrant = {
  live: true,
  expires_at: new Date(1_000_000 + 180 * 24 * 3_600_000).toISOString(),
};

const DEAD_GRANT: TriageKeyGrant = { live: false, expires_at: null };

Deno.test("an expired access token with a live OAuth grant is rotation, not expiry", () => {
  const move = { type: "move" as const, folder: "X" };
  assert(
    checkTriageAuthority(EXPIRED_KEY, "inbox-1", move, 1_000_000, LIVE_GRANT).ok,
    "a key between refreshes, on a connection that is still authorized, may run",
  );
});

Deno.test("an expired access token whose grant is gone still fails", () => {
  const move = { type: "move" as const, folder: "X" };

  const noGrant = checkTriageAuthority(EXPIRED_KEY, "inbox-1", move, 1_000_000, null);
  assert(!noGrant.ok, "no OAuth chain means a dashboard key, and those expire for real");
  assertEquals(
    !noGrant.ok ? noGrant.error_code : "",
    "api_key_expired",
    "and it is reported as an expiry",
  );

  const revoked = checkTriageAuthority(EXPIRED_KEY, "inbox-1", move, 1_000_000, DEAD_GRANT);
  assert(!revoked.ok, "a revoked or aged-out refresh chain is a real end of authority");
  assert(
    !revoked.ok && revoked.error_detail.includes("Reconnect"),
    "and it tells the user the fix is to reconnect the client, not to edit the rule",
  );
});

Deno.test("following rotation never launders a genuine revocation", () => {
  const move = { type: "move" as const, folder: "X" };

  // Deleted key + live chain: the dashboard revoke sets deleted_at AND kills
  // the chain, but even a half-applied revocation must stop the rule.
  const deleted = checkTriageAuthority(
    { ...EXPIRED_KEY, deleted_at: "2026-08-01T00:00:00Z" },
    "inbox-1",
    move,
    1_000_000,
    LIVE_GRANT,
  );
  assert(!deleted.ok, "a deleted key fails even when a refresh chain is still live");
  assertEquals(
    !deleted.ok ? deleted.error_code : "",
    "api_key_unavailable",
    "revocation keeps its own error code",
  );

  // Scope and inbox restriction are still read off the LIVE key row, so a
  // rotation-following run can never do more than the key may currently do.
  const descoped = checkTriageAuthority(
    { ...EXPIRED_KEY, scopes: [] },
    "inbox-1",
    move,
    1_000_000,
    LIVE_GRANT,
  );
  assert(!descoped.ok, "a scope removed since the rule was written still bites");
  assertEquals(!descoped.ok ? descoped.error_code : "", "scope_denied", "named as a scope denial");

  const wrongInbox = checkTriageAuthority(
    { ...EXPIRED_KEY, inbox_ids: ["other-inbox"] },
    "inbox-1",
    move,
    1_000_000,
    LIVE_GRANT,
  );
  assert(!wrongInbox.ok, "an inbox the key was restricted away from still bites");
  assertEquals(
    !wrongInbox.ok ? wrongInbox.error_code : "",
    "inbox_not_permitted",
    "named as an inbox restriction",
  );
});

Deno.test("a run whose key is mid-rotation completes instead of failing", async () => {
  const state = freshState({ apiKey: EXPIRED_KEY, keyGrant: LIVE_GRANT });
  const applied = { calls: [] as any[] };

  const summary = await runTriageRule(fakeDeps(state, [fakeMatch("m")], applied), fakeRule());

  assertEquals(summary.status, "completed", "the run is not a failure");
  assertEquals(summary.error_code, null, "and carries no error code");
  assertEquals(applied.calls.length, 1, "the mailbox work actually happened");
  assertEquals(
    state.released[0].consecutive_failures,
    0,
    "so the failure counter that used to march to the auto-disable stays at zero",
  );
});

Deno.test("a store that cannot look up the grant fails closed, not open", async () => {
  const state = freshState({ apiKey: EXPIRED_KEY, keyGrant: LIVE_GRANT });
  const applied = { calls: [] as any[] };
  const deps: TriageDeps = {
    ...fakeDeps(state, [fakeMatch("m")], applied),
    store: storeWithoutGrantLookup(state),
  };

  const summary = await runTriageRule(deps, fakeRule());

  assertEquals(summary.error_code, "api_key_expired", "an unanswerable grant question fails the run");
  assertEquals(applied.calls.length, 0, "and the mailbox is untouched");
});

// ---------------------------------------------------------------------------
// The auto-disable must not be silent
// ---------------------------------------------------------------------------

Deno.test("auto-disabling at the failure ceiling notifies, and only then", async () => {
  const notified: any[] = [];
  const notifyDeps = (state: FakeState, applied: { calls: any[] }): TriageDeps => ({
    ...fakeDeps(state, [fakeMatch("m")], applied),
    notifyRuleDisabled: (input) => {
      notified.push(input);
      return Promise.resolve();
    },
  });

  // One short of the ceiling: the rule keeps going, so there is nothing to say.
  const nearState = freshState({ apiKey: null });
  await runTriageRule(
    notifyDeps(nearState, { calls: [] }),
    fakeRule({ consecutive_failures: 3 }),
  );
  assertEquals(notified.length, 0, "a failure that does not disable the rule is not announced");

  // The fifth consecutive failure switches the rule off, which is the moment a
  // person has to be told: from here on the rule does nothing at all.
  const state = freshState({ apiKey: null });
  await runTriageRule(
    notifyDeps(state, { calls: [] }),
    fakeRule({ consecutive_failures: 4, name: "Archive newsletters" }),
  );
  assertEquals(notified.length, 1, "the auto-disable is announced exactly once");
  assertEquals(notified[0].ruleId, "rule-1", "the notification names the rule");
  assertEquals(notified[0].workspaceId, "ws-1", "and its workspace");
  assertEquals(notified[0].errorCode, "api_key_unavailable", "and why it stopped");
  assertEquals(notified[0].consecutiveFailures, 5, "and how many runs it took");
  assert(state.released[0].enabled === false, "the rule really is switched off");
});

Deno.test("a notifier that throws does not become a second failure", async () => {
  const state = freshState({ apiKey: null });
  const deps: TriageDeps = {
    ...fakeDeps(state, [fakeMatch("m")], { calls: [] }),
    notifyRuleDisabled: () => Promise.reject(new Error("pg_net is down")),
  };

  const summary = await runTriageRule(deps, fakeRule({ consecutive_failures: 4 }));

  assertEquals(summary.error_code, "api_key_unavailable", "the run reports the ORIGINAL cause");
  assertEquals(state.released[0].enabled, false, "and the rule is still switched off");
});

Deno.test("a revoked key stops the run before any provider call", async () => {
  const state = freshState({ apiKey: null });
  const applied = { calls: [] as any[] };
  const summary = await runTriageRule(fakeDeps(state, [fakeMatch("m")], applied), fakeRule());
  assertEquals(summary.error_code, "api_key_unavailable", "the run names the cause");
  assertEquals(applied.calls.length, 0, "and the mailbox is untouched");
});

// ---------------------------------------------------------------------------
// Run-log redaction
// ---------------------------------------------------------------------------

Deno.test("run-log fields are neutralized and truncated to 120 characters", () => {
  assertEquals(
    redactForRunLog(`invoice${RLO} fdp.exe`),
    "invoice fdp.exe",
    "bidi overrides are stripped before the value is stored",
  );
  const long = redactForRunLog("x".repeat(500));
  assertEquals((long ?? "").length, 120, "the value is truncated to the column's documented cap");
  assertEquals(redactForRunLog(null), null, "a missing value stays null");
  assertEquals(redactForRunLog("   "), null, "a blank value stays null");
});

Deno.test("run items carry a redacted subject and sender, never a body", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  await runTriageRule(
    fakeDeps(state, [fakeMatch("msg-a", { subject: "y".repeat(400) })], applied),
    fakeRule(),
  );
  const item = state.runItems[0];
  assertEquals((item.subject_redacted as string).length, 120, "the subject is truncated");
  assertEquals(item.sender_redacted, "news@example.com", "the sender is recorded");
  assert(!("body" in item) && !("preview" in item), "no body-shaped field exists on a run item");
});

Deno.test("undo state is encrypted before it is stored", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  await runTriageRule(fakeDeps(state, [fakeMatch("msg-a")], applied), fakeRule());
  const item = state.runItems[0];
  assertEquals(item.undo_state.v, 1, "the stored wrapper is versioned");
  assert(
    typeof item.undo_state.data === "string" && item.undo_state.data.startsWith("enc("),
    "the provider ids go through the encryption helper, never in cleartext",
  );
});

Deno.test("a queued forward records queued_for_approval and no undo state", async () => {
  const state = freshState();
  const applied = { calls: [] as any[] };
  const deps = fakeDeps(state, [fakeMatch("msg-a")], applied, {
    ok: true,
    approval_id: "approval-1",
  });
  await runTriageRule(deps, fakeRule({ action: { type: "forward", to: ["x@y.co"] } }));
  const item = state.runItems[0];
  assertEquals(
    item.outcome,
    "queued_for_approval",
    "nothing happened to the mailbox and nothing will until a human decides",
  );
  assertEquals(item.undo_state, null, "there is nothing to undo");
  assertEquals(item.detail.approval_id, "approval-1", "the approval is named so it can be found");
});

// ---------------------------------------------------------------------------
// The `automation` tool surface
//
// A minimal fake of the PostgREST builder: enough to observe WHAT WAS WRITTEN,
// which for this tool is the whole question. Faithful where it matters, in that
// an insert really does return the row the handler then echoes.
// ---------------------------------------------------------------------------

interface FakeDbLog {
  inserts: any[];
  updates: any[];
  rows: Record<string, any[]>;
}

function fakeAutomationDb(log: FakeDbLog): any {
  const builder = (table: string) => {
    const state: any = { table, op: "select", patch: null };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      not: () => chain,
      lte: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: log.rows[table] ?? [], error: null }),
      insert: (row: any) => {
        state.op = "insert";
        state.patch = row;
        log.inserts.push({ table, row });
        return chain;
      },
      update: (patch: any) => {
        state.op = "update";
        state.patch = patch;
        log.updates.push({ table, patch });
        return chain;
      },
      maybeSingle: () => {
        if (state.op === "insert") {
          return Promise.resolve({ data: { id: "rule-new", ...state.patch }, error: null });
        }
        if (state.op === "update") {
          const base = (log.rows[table] ?? [])[0] ?? { id: "rule-1" };
          return Promise.resolve({ data: { ...base, ...state.patch }, error: null });
        }
        return Promise.resolve({ data: (log.rows[table] ?? [])[0] ?? null, error: null });
      },
      then: undefined,
    };
    return chain;
  };
  return { from: builder };
}

function automationDeps(log: FakeDbLog, previewed: { calls: any[] }): any {
  return {
    db: fakeAutomationDb(log),
    caller: {
      id: "key-1",
      workspace_id: "ws-1",
      scopes: ["read:email", "manage:folders", "manage:drafts", "send:email", "manage:automations"],
      inbox_ids: null,
    },
    resolveInbox: () =>
      Promise.resolve({
        ok: true,
        inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@b.com", provider: "gmail" },
      }),
    preview: (...callArgs: any[]) => {
      previewed.calls.push(callArgs);
      return Promise.resolve([fakeMatch("msg-a")]);
    },
    now: () => 1_000_000,
  };
}

Deno.test("automation create refuses a delete-shaped rule action and writes nothing", async () => {
  const log: FakeDbLog = { inserts: [], updates: [], rows: {} };
  const previewed = { calls: [] as any[] };
  const { runAutomationTool } = await import("./triage-engine.ts");

  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Nuke it",
    filter: { from: "spam@x.co" },
    rule_action: { type: "delete" },
    interval_minutes: 60,
  }, automationDeps(log, previewed));

  assert(result.result.isError === true, "the call is an error");
  assertEquals(log.inserts.length, 0, "no rule row is written");
});

Deno.test("automation create stores the rule DISABLED with no next_run_at", async () => {
  const log: FakeDbLog = { inserts: [], updates: [], rows: {} };
  const previewed = { calls: [] as any[] };
  const { runAutomationTool } = await import("./triage-engine.ts");

  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Archive newsletters",
    filter: { from: "news@example.com" },
    rule_action: { type: "move", folder: "Newsletters" },
    interval_minutes: 60,
  }, automationDeps(log, previewed));

  assertEquals(result.logStatus, "success", "the call succeeds");
  assertEquals(log.inserts.length, 1, "exactly one rule row is written");
  const row = log.inserts[0].row;
  assertEquals(row.enabled, false, "a new rule is always created OFF");
  assertEquals(row.next_run_at, null, "and is not scheduled until it is enabled");
  assertEquals(row.api_key_id, "key-1", "the rule runs as the calling key");
});

Deno.test("automation update with only a name does not misread the action selector", async () => {
  // The regression this guards: `action` on the wire is the operation selector
  // ("update"), and index.ts only overwrites it when rule_action was supplied.
  // Reading it as a rule action produced a baffling "action.type is required".
  const log: FakeDbLog = { inserts: [], updates: [], rows: { triage_rules: [{ id: "rule-1", inbox_id: "inbox-1" }] } };
  const previewed = { calls: [] as any[] };
  const { runAutomationTool } = await import("./triage-engine.ts");

  const result = await runAutomationTool("update", {
    automation_id: "11111111-2222-3333-4444-555555555555",
    action: "update",
    name: "Renamed",
  }, automationDeps(log, previewed));

  assertEquals(result.logStatus, "success", "renaming a rule is a valid update");
  const patch = log.updates[0].patch;
  assertEquals(patch.name, "Renamed", "the name is changed");
  assert(!("action" in patch), "and no action is written from the selector string");
});

Deno.test("automation preview is a dry run that persists nothing", async () => {
  const log: FakeDbLog = { inserts: [], updates: [], rows: {} };
  const previewed = { calls: [] as any[] };
  const { runAutomationTool } = await import("./triage-engine.ts");

  const result = await runAutomationTool("preview", {
    inbox_id: "inbox-1",
    filter: { from: "news@example.com" },
  }, automationDeps(log, previewed));

  assertEquals(result.logStatus, "success", "the preview succeeds");
  const payload = result.result.structuredContent as any;
  assertEquals(payload.applied, false, "a preview always reports that it applied nothing");
  assertEquals(payload.matched, 1, "and reports what the filter matched");
  assertEquals(payload.untrusted_content, true, "matches are marked as mailbox content");
  assertEquals(log.inserts.length, 0, "NO triage_runs row is written");
  assertEquals(log.updates.length, 0, "and nothing is updated");
  assertEquals(previewed.calls.length, 1, "the search ran exactly once");
});

Deno.test("automation preview refuses an empty filter", async () => {
  const log: FakeDbLog = { inserts: [], updates: [], rows: {} };
  const previewed = { calls: [] as any[] };
  const { runAutomationTool } = await import("./triage-engine.ts");

  const result = await runAutomationTool("preview", { inbox_id: "inbox-1", filter: {} }, automationDeps(log, previewed));
  assert(result.result.isError === true, "an everything-matching filter is refused");
  assertEquals(previewed.calls.length, 0, "and no search is run against the mailbox");
});

Deno.test("automation delete is a soft delete that keeps run history", async () => {
  const log: FakeDbLog = { inserts: [], updates: [], rows: { triage_rules: [{ id: "rule-1" }] } };
  const previewed = { calls: [] as any[] };
  const { runAutomationTool } = await import("./triage-engine.ts");

  await runAutomationTool("delete", {
    automation_id: "11111111-2222-3333-4444-555555555555",
  }, automationDeps(log, previewed));

  const patch = log.updates[0].patch;
  assert(typeof patch.deleted_at === "string", "deleted_at is stamped");
  assertEquals(patch.enabled, false, "and the rule is switched off");
  assertEquals(patch.next_run_at, null, "so nothing further is scheduled");
});

Deno.test("automation create refuses an action the calling key lacks the scope for", async () => {
  const log: FakeDbLog = { inserts: [], updates: [], rows: {} };
  const previewed = { calls: [] as any[] };
  const deps = automationDeps(log, previewed);
  // A key that may manage automations but may not send.
  deps.caller.scopes = ["read:email", "manage:automations"];
  const { runAutomationTool } = await import("./triage-engine.ts");

  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Forward invoices",
    filter: { subject: "invoice" },
    rule_action: { type: "forward", to: ["ap@example.com"] },
    interval_minutes: 60,
  }, deps);

  assert(result.result.isError === true, "the rule can never do more than the key itself may do");
  assertEquals(result.logErrorCode, "scope_denied", "and says so plainly");
  assertEquals(log.inserts.length, 0, "nothing is written");
});

// ---------------------------------------------------------------------------
// label on every provider
//
// `label` shipped Gmail-only. It is not: Outlook calls it a category and IMAP
// calls it a keyword, and IMAP is 110 of the 163 connected inboxes, so the
// Gmail-only version was wrong for the majority case. What survives from the
// old restriction is a NAME check, and only on IMAP, where a keyword is an atom.
// ---------------------------------------------------------------------------

/** A create-a-label-rule call against one provider. */
async function createLabelRule(
  provider: string,
  label: string,
): Promise<{ result: any; log: FakeDbLog }> {
  const log: FakeDbLog = { inserts: [], updates: [], rows: {} };
  const previewed = { calls: [] as any[] };
  const deps = automationDeps(log, previewed);
  deps.resolveInbox = () =>
    Promise.resolve({
      ok: true,
      inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@b.com", provider },
    });
  const { runAutomationTool } = await import("./triage-engine.ts");
  const result = await runAutomationTool("create", {
    inbox_id: "inbox-1",
    name: "Tag receipts",
    filter: { subject: "receipt" },
    rule_action: { type: "label", label },
    interval_minutes: 60,
  }, deps);
  return { result, log };
}

Deno.test("a label rule now validates on Gmail, Outlook and IMAP alike", async () => {
  for (const provider of ["gmail", "outlook", "imap"]) {
    const { result, log } = await createLabelRule(provider, "Receipts");
    assertEquals(result.logStatus, "success", `a label rule is accepted on ${provider}`);
    assertEquals(log.inserts.length, 1, `and is stored on ${provider}`);
    assertEquals(
      log.inserts[0].row.action,
      { type: "label", label: "Receipts" },
      "the label is stored VERBATIM, so the rule reads back as it was written",
    );
  }
});

Deno.test("an IMAP label that cannot be a legal keyword is refused when it is written", async () => {
  // An IMAP keyword is an atom, so these characters cannot appear in one.
  // Silently stripping them would leave the mailbox holding a keyword the
  // dashboard never shows, so the rule is refused instead.
  for (const label of ["Sale (50%)", "Work [urgent]", 'Say "hi"', "back\\slash", "{braced}"]) {
    const { result, log } = await createLabelRule("imap", label);
    assert(result.result.isError === true, `"${label}" is refused on IMAP`);
    assertEquals(log.inserts.length, 0, `and no rule row is written for "${label}"`);
    const text = (result.result.content[0] as any).text as string;
    assert(
      text.includes("IMAP keyword"),
      "the refusal names the IMAP keyword, so the user knows what the constraint is",
    );
    assert(text.includes("move action"), "and points at the action that has no such limit");
  }
});

Deno.test("an IMAP label may not begin with a backslash", async () => {
  // That namespace belongs to system flags (\Seen, \Flagged). A rule that set
  // one would be a rule that could mark mail read under another name.
  const { result, log } = await createLabelRule("imap", "\\Seen");
  assert(result.result.isError === true, "a system-flag-shaped keyword is refused");
  assertEquals(log.inserts.length, 0, "and nothing is written");
  const text = (result.result.content[0] as any).text as string;
  assert(text.includes("system flags"), "the refusal says why that namespace is off limits");
});

Deno.test("spaces in an IMAP label become underscores, and the caller is told so", async () => {
  const { result, log } = await createLabelRule("imap", "Order updates");
  assertEquals(result.logStatus, "success", "a multi-word label is accepted");
  assertEquals(
    log.inserts[0].row.action.label,
    "Order updates",
    "the rule stores what the user typed",
  );
  const payload = result.result.structuredContent as any;
  assert(
    String(payload.message).includes("Order_updates"),
    "but the caller is told the KEYWORD the mailbox will actually carry",
  );
  assert(
    String(payload.label_applied_as).includes("IMAP keyword"),
    "and the noun is named, because IMAP does not have labels",
  );
});

Deno.test("an Outlook label rule says it will be applied as a category", async () => {
  const { result } = await createLabelRule("outlook", "Receipts");
  const payload = result.result.structuredContent as any;
  assert(
    String(payload.label_applied_as).includes("Outlook category"),
    "Outlook calls it a category, and the copy should not pretend otherwise",
  );
});

Deno.test("a Gmail label rule carries no rename note, because nothing is renamed", async () => {
  const { result } = await createLabelRule("gmail", "Order updates");
  const payload = result.result.structuredContent as any;
  assert(
    payload.label_applied_as === undefined,
    "a note that says nothing new is noise",
  );
});

Deno.test("the IMAP keyword rules are exactly what the seam will send", () => {
  const ok = normalizeImapKeyword("  Order   updates  ");
  assert(ok.ok === true, "a multi-word label normalises");
  if (ok.ok) {
    assertEquals(ok.target.applied_as, "Order_updates", "runs of whitespace collapse to one underscore");
    assertEquals(ok.target.transformed, true, "and the transformation is reported, never silent");
    assertEquals(ok.target.kind, "keyword", "IMAP calls it a keyword");
  }
  const untouched = normalizeImapKeyword("Receipts");
  assert(untouched.ok === true && untouched.target.transformed === false, "a legal keyword is left alone");
  assert(normalizeImapKeyword("").ok === false, "an empty label is refused");
  assert(normalizeImapKeyword("kvittering-2026_q3").ok === true, "hyphens, digits and underscores are legal");
  assert(normalizeImapKeyword("\u53d7\u636e").ok === false, "non-ASCII cannot be an IMAP atom, so it is refused rather than mangled");
  assert(normalizeImapKeyword("x".repeat(MAX_IMAP_KEYWORD_CHARS + 1)).ok === false, "over-long keywords are refused");
  assert(normalizeImapKeyword("x".repeat(MAX_IMAP_KEYWORD_CHARS)).ok === true, "and the ceiling itself is allowed");
});

Deno.test("labelTargetFor names the right thing per provider", () => {
  const gmail = labelTargetFor("gmail", "Order updates");
  assert(gmail.ok === true && gmail.target.kind === "label", "Gmail has labels");
  assert(gmail.ok === true && gmail.target.applied_as === "Order updates", "and no naming constraint");
  const outlook = labelTargetFor("outlook", "Order updates");
  assert(outlook.ok === true && outlook.target.kind === "category", "Outlook has categories");
  assert(outlook.ok === true && outlook.target.applied_as === "Order updates", "and no naming constraint");
  const imap = labelTargetFor("imap", "Order updates");
  assert(imap.ok === true && imap.target.kind === "keyword", "IMAP has keywords");
  // A service we have never heard of is IMAP-shaped, not waved through: every
  // IMAP service is stored as provider="imap", so an unknown value is a bug or
  // a new IMAP service, and both want the stricter answer.
  const unknown = labelTargetFor("some-new-imap-service", "Order updates");
  assert(unknown.ok === true && unknown.target.kind === "keyword", "an unknown provider is treated as IMAP");
});

// ---------------------------------------------------------------------------
// The Outlook merge
//
// THE DATA-LOSS CASE. Graph's `categories` is a REPLACE: a PATCH carrying one
// category makes it the message's ONLY category. A rule that labelled 200
// messages without reading first would strip every category the user had put on
// them, unrecoverably and unattended, which is the worst thing this feature
// could do.
// ---------------------------------------------------------------------------

Deno.test("the Outlook merge preserves the categories a message already has", () => {
  const merged = mergeOutlookCategories(["Personal", "Tax"], "Receipts");
  assertEquals(
    merged.categories,
    ["Personal", "Tax", "Receipts"],
    "the PATCH body carries the EXISTING categories plus the new one, never the new one alone",
  );
  assertEquals(merged.changed, true, "and the write is worth making");
});

Deno.test("the Outlook merge skips the write when the category is already there", () => {
  const merged = mergeOutlookCategories(["Personal", "Receipts"], "Receipts");
  assertEquals(merged.changed, false, "nothing to add means no PATCH at all");
  assertEquals(merged.categories, ["Personal", "Receipts"], "and nothing is reordered or dropped");
});

Deno.test("the Outlook merge matches case-insensitively and keeps the existing casing", () => {
  // Outlook's own category list is case-insensitive, so "receipts" and
  // "Receipts" are one category. Rewriting the casing would be a silent edit of
  // something the user named.
  const merged = mergeOutlookCategories(["receipts"], "Receipts");
  assertEquals(merged.changed, false, "the category is recognised as already present");
  assertEquals(merged.categories, ["receipts"], "with the user's casing untouched");
});

Deno.test("the Outlook merge on a message with no categories yet writes just the one", () => {
  assertEquals(mergeOutlookCategories([], "Receipts").categories, ["Receipts"], "the empty case still works");
});

Deno.test("an Outlook label run sends a PATCH that keeps the pre-existing categories", async () => {
  // The engine-level half of the same property: `applyAction` here stands in for
  // index.ts's `applyLabelToMessage` and records the body it would have PATCHed,
  // so the assertion is on WHAT REACHES THE PROVIDER, not on the merge alone.
  const state = freshState({
    inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@b.com", provider: "outlook" },
  });
  const patches: any[] = [];
  const mailbox = new Map<string, string[]>([
    ["msg-a", ["Personal", "Tax"]],
    ["msg-b", ["Receipts"]],
  ]);
  const deps: TriageDeps = {
    ...fakeDeps(state, [fakeMatch("msg-a"), fakeMatch("msg-b")], { calls: [] }),
    applyAction: (input) => {
      const label = (input.action as any).label as string;
      const merged = mergeOutlookCategories(mailbox.get(input.match.id) ?? [], label);
      if (merged.changed) patches.push({ id: input.match.id, categories: merged.categories });
      return Promise.resolve({
        ok: true,
        detail: {
          label,
          applied_as: label,
          target: "category",
          ...(merged.changed ? {} : { already_present: true }),
        },
        undo: merged.changed ? { op: "label", message_id: input.match.id } : null,
      });
    },
  };

  const summary = await runTriageRule(deps, fakeRule({ action: { type: "label", label: "Receipts" } }));

  assertEquals(summary.succeeded, 2, "both messages are handled");
  assertEquals(patches.length, 1, "only the message that was missing the category is written to");
  assertEquals(
    patches[0].categories,
    ["Personal", "Tax", "Receipts"],
    "and that write CARRIES THE USER'S EXISTING CATEGORIES: dropping them would be silent data loss",
  );
  const items = state.runItems.filter((i) => i.outcome === "applied");
  assertEquals(items[0].detail.target, "category", "the run log names what the provider actually calls it");
  assertEquals(items[1].detail.already_present, true, "and says when the message already carried it");
  assertEquals(items[1].undo_state, null, "with no undo, because nothing was done to reverse");
});

Deno.test("a run log records the name the mailbox actually carries, not the one typed", async () => {
  const state = freshState({
    inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@b.com", provider: "imap" },
  });
  const deps: TriageDeps = {
    ...fakeDeps(state, [fakeMatch("msg-a")], { calls: [] }),
    applyAction: (input) => {
      const label = (input.action as any).label as string;
      const target = labelTargetFor("imap", label);
      const appliedAs = target.ok ? target.target.applied_as : label;
      return Promise.resolve({
        ok: true,
        detail: { label, applied_as: appliedAs, target: "keyword" },
        undo: { op: "label", message_id: input.match.id, applied_as: appliedAs },
      });
    },
  };

  await runTriageRule(deps, fakeRule({ action: { type: "label", label: "Order updates" } }));

  const item = state.runItems[0];
  assertEquals(item.detail.label, "Order updates", "what was asked for");
  assertEquals(item.detail.applied_as, "Order_updates", "and what the mailbox actually holds");
  assertEquals(item.detail.target, "keyword", "under the name IMAP uses for it");
});

Deno.test("a run that cannot apply a keyword fails loudly rather than reporting success", async () => {
  // The silent-failure case the PERMANENTFLAGS check exists to prevent: a server
  // that does not keep custom keywords must produce a failed run item, not an
  // applied one over a mailbox where nothing changed.
  const state = freshState({
    inbox: { id: "inbox-1", workspace_id: "ws-1", email_address: "a@b.com", provider: "imap" },
  });
  const deps: TriageDeps = {
    ...fakeDeps(state, [fakeMatch("msg-a")], { calls: [] }),
    applyAction: () => Promise.resolve({ ok: false, error_code: "imap_keywords_unsupported" }),
  };

  const summary = await runTriageRule(deps, fakeRule({ action: { type: "label", label: "Receipts" } }));

  assertEquals(summary.failed, 1, "the message counts as failed");
  assertEquals(summary.succeeded, 0, "and never as applied");
  assertEquals(state.runItems[0].outcome, "failed", "the run log says so");
  assertEquals(
    state.runItems[0].detail.error_code,
    "imap_keywords_unsupported",
    "with a code that names the cause instead of a generic provider error",
  );
});

Deno.test("PERMANENTFLAGS decides whether a server takes custom keywords", () => {
  assertEquals(
    permanentFlagsAllowKeyword(["\\Seen", "\\Deleted", "\\*"], "Receipts"),
    true,
    "\\* is the server saying a client may invent keywords",
  );
  assertEquals(
    permanentFlagsAllowKeyword(["\\Seen", "\\Deleted"], "Receipts"),
    false,
    "a fixed list without \\* means this keyword will not stick",
  );
  assertEquals(
    permanentFlagsAllowKeyword(["\\Seen", "Receipts"], "receipts"),
    true,
    "a pre-provisioned keyword counts, case-insensitively",
  );
  assertEquals(
    permanentFlagsAllowKeyword(null, "Receipts"),
    null,
    "no PERMANENTFLAGS at all is an absence of information, not a refusal",
  );
});

Deno.test("PERMANENTFLAGS is parsed out of the SELECT response", () => {
  assertEquals(
    parsePermanentFlags([
      "* 231 EXISTS",
      "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited",
    ]),
    ["\\Answered", "\\Flagged", "\\Deleted", "\\Seen", "\\Draft", "\\*"],
    "the untagged OK response code is where custom-keyword support is announced",
  );
  assertEquals(
    parsePermanentFlags(["* 231 EXISTS", "* OK [UIDVALIDITY 1] UIDs valid"]),
    null,
    "a SELECT that never mentions PERMANENTFLAGS yields null, not an empty list",
  );
});

Deno.test("a move whose destination is trash or junk is refused", () => {
  // Blocking an action literally named "delete" is not enough on its own:
  // every provider empties trash and junk on a timer, so a move there is an
  // unattended delete with a delayed fuse. The product claim is that
  // automations never delete mail, so the destination is checked too.
  for (
    const folder of [
      "Trash",
      "trash",
      "TRASH",
      "Bin",
      "Deleted Items",
      "deleted  items",
      "Deleted Messages",
      "Junk",
      "Spam",
      // Provider-prefixed paths must resolve to the same leaf.
      "[Gmail]/Trash",
      "INBOX.Trash",
      "INBOX/Deleted Items",
    ]
  ) {
    const result = validateTriageAction({ type: "move", folder });
    assert(!result.ok, `move to '${folder}' must be refused`);
    assert(
      !result.ok && /trash and junk/i.test(result.error),
      `refusal for '${folder}' must explain why, got: ${!result.ok ? result.error : ""}`,
    );
  }
});

Deno.test("a move to an ordinary folder is still allowed", () => {
  // The guard must not overreach: only the destination is checked, and only
  // against trash-like leaves. Moving mail OUT of trash, and any folder whose
  // name merely contains one of those words, stay allowed.
  for (const folder of ["Archive", "Clients", "Receipts 2026", "Trashed drafts", "Junk mail leads"]) {
    const result = validateTriageAction({ type: "move", folder });
    assert(result.ok, `move to '${folder}' must be allowed, got: ${!result.ok ? result.error : ""}`);
  }
});
