// Inbox visibility for credentials (inbox-visibility.ts, migration 20261111190000).
//
// Run: HOST_GUARD_SKIP_NETWORK_TESTS=1 deno test --node-modules-dir=none \
//        --allow-read --allow-env --allow-run=git supabase/functions/mcp-server/inbox-visibility.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  approvalActingKey,
  countTeammatePrivateInboxes,
  credentialCanReachInbox,
  effectiveInboxIds,
  inboxAllowed,
  inboxesVisibleToAudienceOf,
  NO_INBOX_ID,
  parseCredentialScope,
  readCredentialScope,
  readCredentialScopeForKey,
  scopeForKey,
  teammatePrivateInboxesMessage,
  userCanReachInbox,
} from "./inbox-visibility.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-0000-4000-8000-000000000001"; // inbox owner
const B = "bbbbbbbb-0000-4000-8000-000000000002"; // another member
const PRIV_A = "a1a1a1a1-0000-4000-8000-000000000001";
const COMPANY = "c0c0c0c0-0000-4000-8000-000000000001";

// ── parseCredentialScope ────────────────────────────────────────────────────

Deno.test("parse: restricted list, unrestricted null, malformed answers", () => {
  assertEquals(parseCredentialScope({ restricted: true, inbox_ids: [COMPANY] }), { restricted: true, inbox_ids: [COMPANY] });
  assertEquals(parseCredentialScope({ restricted: false, inbox_ids: null }), { restricted: false, inbox_ids: null });
  assertEquals(parseCredentialScope({ restricted: true, inbox_ids: null }), null, "restricted must name its list");
  assertEquals(parseCredentialScope({ restricted: "yes", inbox_ids: [] }), null);
  assertEquals(parseCredentialScope({ restricted: true, inbox_ids: [1] }), null);
  assertEquals(parseCredentialScope(null), null);
  assertEquals(parseCredentialScope([]), null);
});

// ── effectiveInboxIds ──────────────────────────────────────────────────────

Deno.test("effective: unrestricted keeps the key's own allow-list exactly (single-member workspaces unchanged)", () => {
  assertEquals(effectiveInboxIds(null, { restricted: false, inbox_ids: null }), null);
  assertEquals(effectiveInboxIds([PRIV_A], { restricted: false, inbox_ids: [PRIV_A] }), [PRIV_A]);
});

Deno.test("effective: restricted uses the scope's list", () => {
  assertEquals(effectiveInboxIds(null, { restricted: true, inbox_ids: [COMPANY] }), [COMPANY]);
});

Deno.test("effective: restricted to nothing never becomes [] (several resolvers read [] as all)", () => {
  assertEquals(effectiveInboxIds(null, { restricted: true, inbox_ids: [] }), [NO_INBOX_ID]);
  assertEquals(effectiveInboxIds([PRIV_A], { restricted: true, inbox_ids: [] }), [NO_INBOX_ID]);
});

Deno.test("effective: a failed read fails closed", () => {
  assertEquals(effectiveInboxIds(null, null), [NO_INBOX_ID]);
  assertEquals(effectiveInboxIds([PRIV_A], null), [NO_INBOX_ID]);
});

Deno.test("inboxAllowed: null and [] are the key's 'all', a list is membership", () => {
  assert(inboxAllowed(null, PRIV_A));
  assert(inboxAllowed([], PRIV_A));
  assert(inboxAllowed([PRIV_A], PRIV_A));
  assert(!inboxAllowed([NO_INBOX_ID], PRIV_A));
});

// ── readCredentialScope / credentialCanReachInbox against a fake RPC ───────

/**
 * A stand-in for credential_inbox_scope with the SQL's semantics: inboxes
 * {PRIV_A: private, owner A} and {COMPANY: company}; A and B are members.
 */
function fakeDb(opts: { members?: string[]; rpcError?: boolean; keys?: Record<string, unknown>[] } = {}) {
  const members = opts.members ?? [A, B];
  const inboxes = [
    { id: PRIV_A, visibility: "private", owner_user_id: A },
    { id: COMPANY, visibility: "company", owner_user_id: A },
  ];
  const rpcCalls: Record<string, unknown>[] = [];
  return {
    rpcCalls,
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, ...args });
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: "boom" } });
      const user = (args.p_user_id as string | null) ?? A; // null acts as the workspace owner (A)
      if (!members.includes(user)) return Promise.resolve({ data: { restricted: true, inbox_ids: [] }, error: null });
      const hidden = inboxes.filter((i) => i.visibility === "private" && i.owner_user_id !== user).map((i) => i.id);
      const keyIds = args.p_inbox_ids as string[] | null;
      if (hidden.length === 0) return Promise.resolve({ data: { restricted: false, inbox_ids: keyIds }, error: null });
      const base = keyIds && keyIds.length ? keyIds : inboxes.map((i) => i.id);
      return Promise.resolve({ data: { restricted: true, inbox_ids: base.filter((x) => !hidden.includes(x)) }, error: null });
    },
    from(_table: string) {
      let id = "";
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => {
          id = v;
          return q;
        },
        maybeSingle: () => Promise.resolve({ data: (opts.keys ?? []).find((k) => k.id === id) ?? null, error: null }),
      };
      return q;
    },
  };
}

Deno.test("scope: the owner of a private inbox keeps a null allow-list (nothing hidden from them)", async () => {
  const db = fakeDb();
  const scope = await readCredentialScope(db, WS, A, null);
  assertEquals(effectiveInboxIds(null, scope), null);
});

Deno.test("scope: another member's key loses the private inbox, keeps the company one", async () => {
  const db = fakeDb();
  const ids = effectiveInboxIds(null, await readCredentialScope(db, WS, B, null));
  assertEquals(ids, [COMPANY]);
  assert(!inboxAllowed(ids, PRIV_A));
  // A key explicitly allow-listed to the private inbox reaches nothing.
  assertEquals(effectiveInboxIds([PRIV_A], await readCredentialScope(db, WS, B, [PRIV_A])), [NO_INBOX_ID]);
});

Deno.test("scope: a removed member reaches nothing", async () => {
  const db = fakeDb({ members: [A] });
  assertEquals(effectiveInboxIds(null, await readCredentialScope(db, WS, B, null)), [NO_INBOX_ID]);
});

Deno.test("scope: the RPC is asked with the key's creator and allow-list", async () => {
  const db = fakeDb();
  await readCredentialScope(db, WS, B, [COMPANY]);
  assertEquals(db.rpcCalls, [{ name: "credential_inbox_scope", p_workspace_id: WS, p_user_id: B, p_inbox_ids: [COMPANY] }]);
});

Deno.test("scope: an RPC error fails closed", async () => {
  const db = fakeDb({ rpcError: true });
  assertEquals(await readCredentialScope(db, WS, A, null), null);
  assert(!(await userCanReachInbox(db, WS, A, PRIV_A)));
});

Deno.test("userCanReachInbox: owner yes, other member no, company yes for both", async () => {
  const db = fakeDb();
  assert(await userCanReachInbox(db, WS, A, PRIV_A));
  assert(!(await userCanReachInbox(db, WS, B, PRIV_A)));
  assert(await userCanReachInbox(db, WS, B, COMPANY));
});

Deno.test("credentialCanReachInbox: acts as the key's creator; missing or foreign key is no", async () => {
  const db = fakeDb({
    keys: [
      { id: "k-a", workspace_id: WS, created_by: A, inbox_ids: null },
      { id: "k-b", workspace_id: WS, created_by: B, inbox_ids: null },
      { id: "k-x", workspace_id: "other", created_by: A, inbox_ids: null },
    ],
  });
  assert(await credentialCanReachInbox(db, "k-a", WS, PRIV_A));
  assert(!(await credentialCanReachInbox(db, "k-b", WS, PRIV_A)));
  assert(await credentialCanReachInbox(db, "k-b", WS, COMPANY));
  assert(!(await credentialCanReachInbox(db, "k-x", WS, PRIV_A)));
  assert(!(await credentialCanReachInbox(db, "missing", WS, COMPANY)));
  assert(!(await credentialCanReachInbox(db, null, WS, COMPANY)));
});

Deno.test("credentialCanReachInbox: a stored row's created_by wins over the shared web client key's null creator", async () => {
  // The web mail client runs on a key nobody minted (created_by null, which
  // acts as the workspace owner A). The row records who really asked.
  const db = fakeDb({ keys: [{ id: "k-web", workspace_id: WS, created_by: null, inbox_ids: null }] });
  assert(await credentialCanReachInbox(db, "k-web", WS, PRIV_A), "no created_by: acts as the owner");
  assert(await credentialCanReachInbox(db, "k-web", WS, PRIV_A, A), "A set it up on A's private inbox");
  assert(!(await credentialCanReachInbox(db, "k-web", WS, PRIV_A, B)), "B never reaches A's private inbox");
  assert(await credentialCanReachInbox(db, "k-web", WS, COMPANY, B));
  const last = db.rpcCalls.at(-1) as Record<string, unknown>;
  assertEquals(last.p_user_id, B, "the scope is asked for the acting user");
});

Deno.test("approvalActingKey: the shared key acts as the requester; a minted key keeps its creator", () => {
  type Key = { id: string; created_by: string | null };
  const web: Key = { id: "k-web", created_by: null };
  const minted: Key = { id: "k-a", created_by: A };
  assertEquals(approvalActingKey(web, B), { id: "k-web", created_by: B });
  assertEquals(approvalActingKey(minted, B), { id: "k-a", created_by: A });
  assertEquals(approvalActingKey(web, null), { id: "k-web", created_by: null });
  assertEquals(approvalActingKey(web, 42), { id: "k-web", created_by: null });
});

// ── inboxesVisibleToAudienceOf (morning brief) ─────────────────────────────

Deno.test("brief audience: a company-wide target only describes company-wide inboxes", () => {
  const rows = [
    { id: PRIV_A, visibility: "private", owner_user_id: A },
    { id: COMPANY, visibility: "company", owner_user_id: A },
    { id: "priv-b", visibility: "private", owner_user_id: B },
  ];
  assertEquals(inboxesVisibleToAudienceOf(rows[1], rows).map((r) => r.id), [COMPANY]);
});

Deno.test("brief audience: a private target describes company-wide plus its owner's own, never another's", () => {
  const rows = [
    { id: PRIV_A, visibility: "private", owner_user_id: A },
    { id: COMPANY, visibility: "company", owner_user_id: B },
    { id: "priv-b", visibility: "private", owner_user_id: B },
  ];
  assertEquals(inboxesVisibleToAudienceOf(rows[0], rows).map((r) => r.id), [PRIV_A, COMPANY]);
});

Deno.test("brief audience: an ownerless private target describes only itself", () => {
  const rows = [
    { id: PRIV_A, visibility: "private", owner_user_id: null },
    { id: COMPANY, visibility: "company", owner_user_id: B },
  ];
  assertEquals(inboxesVisibleToAudienceOf(rows[0], rows).map((r) => r.id), [PRIV_A]);
});

// ── by-hash scope (asked in parallel with authentication) ──────────────────

Deno.test("by-hash scope: used only for the key authentication accepted", async () => {
  const db = {
    rpc: (_n: string, _a: unknown) =>
      Promise.resolve({ data: { restricted: true, inbox_ids: [COMPANY], key_id: "k-1" }, error: null }),
  };
  const answer = await readCredentialScopeForKey(db, "hash");
  assertEquals(scopeForKey(answer, "k-1"), { restricted: true, inbox_ids: [COMPANY] });
  assertEquals(scopeForKey(answer, "k-2"), null, "an answer for another key is never used");
  assertEquals(effectiveInboxIds(null, scopeForKey(answer, "k-2")), [NO_INBOX_ID]);
});

Deno.test("by-hash scope: an unknown key, an error or a malformed answer is null (fail closed)", async () => {
  const rpcAnswer = (data: unknown, error: unknown = null) => ({ rpc: () => Promise.resolve({ data, error }) });
  assertEquals(await readCredentialScopeForKey(rpcAnswer(null), "h"), null);
  assertEquals(await readCredentialScopeForKey(rpcAnswer(null, { message: "x" }), "h"), null);
  assertEquals(await readCredentialScopeForKey(rpcAnswer({ restricted: true, inbox_ids: [] }), "h"), null, "no key_id");
  assertEquals(await readCredentialScopeForKey({ rpc: () => Promise.reject(new Error("net")) }, "h"), null);
});

// ── teammates' private mailboxes (the "no mailbox connected" fix) ───────────

/** A query-builder fake that records filters and answers with a count. */
function countDb(answer: { count: number | null; error?: { message: string } | null } | "throw") {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "not", "neq"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    if (answer === "throw") return reject(new Error("db down"));
    return resolve({ count: answer.count, error: answer.error ?? null });
  };
  return {
    calls,
    db: { from: (t: string) => { calls.push(["from", [t]]); return builder; } },
  };
}

Deno.test("teammate private count: private, not the caller's, not parked or deleted", async () => {
  const { db, calls } = countDb({ count: 2 });
  assertEquals(await countTeammatePrivateInboxes(db, WS, A), 2);
  const seen = JSON.stringify(calls);
  assert(seen.includes('["from",["inboxes"]]'));
  assert(seen.includes('["eq",["workspace_id","' + WS + '"]]'));
  assert(seen.includes('["eq",["visibility","private"]]'));
  assert(seen.includes('["is",["deleted_at",null]]'));
  assert(seen.includes('["is",["parked_at",null]]'));
  assert(seen.includes('["neq",["owner_user_id","' + A + '"]]'));
});

Deno.test("teammate private count: 0 on error, on a throw, and on no rows", async () => {
  assertEquals(await countTeammatePrivateInboxes(countDb({ count: null, error: { message: "x" } }).db, WS, A), 0);
  assertEquals(await countTeammatePrivateInboxes(countDb("throw").db, WS, A), 0);
  assertEquals(await countTeammatePrivateInboxes(countDb({ count: 0 }).db, WS, A), 0);
});

Deno.test("teammate private message: says private, owned by teammates, both ways forward", () => {
  const one = teammatePrivateInboxesMessage(1, "https://mcpemails.com/dashboard/inboxes");
  assert(one.includes("1 private mailbox, owned by a teammate"));
  const many = teammatePrivateInboxesMessage(3, "https://mcpemails.com/dashboard/inboxes");
  assert(many.includes("3 private mailboxes, owned by teammates"));
  for (const text of [one, many]) {
    assert(text.includes("connect their own mailbox"));
    assert(text.includes("company-wide"));
    assert(!/no mailbox is connected/i.test(text), "never the first-run sentence");
    assert(!text.includes("\u2014"), "no em dash");
  }
});
