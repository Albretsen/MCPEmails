// One held copy per send: a repeat of a fan-out-held send returns the request
// already pending (outbound-brakes.ts#heldSendKey, index.ts#queueSendApproval).
// Run: deno test --node-modules-dir=none --allow-read supabase/functions/mcp-server/held-send-dedupe.test.ts
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { type BrakeDb, checkOutboundBrakes, contentHash, heldSendKey, recipientHashes } from "./outbound-brakes.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const MIGRATION = await Deno.readTextFile(
  new URL("../../migrations/20261117120000_held_send_dedupe_key.sql", import.meta.url),
);
const SELF_HOST = await Deno.readTextFile(new URL("../../../self-host/db/00-schema.sql", import.meta.url));

const body = (name: string) => {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert(start > 0, `${name} exists`);
  return SOURCE.slice(start, SOURCE.indexOf("\n}\n", start));
};

Deno.test("the same message to the same people has one key, whatever the recipient order", async () => {
  const hash = await contentHash("Launch", "Hello all");
  const a = await heldSendKey(hash, await recipientHashes(["a@x.example", "B@x.example", "c@x.example"]));
  const b = await heldSendKey(hash, await recipientHashes(["Cee <c@x.example>", "a@x.example", "b@x.example"]));
  assert(a && /^[0-9a-f]{64}$/.test(a));
  assertEquals(a, b);
});

Deno.test("another batch or another message gets another key", async () => {
  const hash = await contentHash("Launch", "Hello all");
  const base = await heldSendKey(hash, await recipientHashes(["a@x.example", "b@x.example"]));
  assertNotEquals(base, await heldSendKey(hash, await recipientHashes(["a@x.example", "c@x.example"])));
  assertNotEquals(
    base,
    await heldSendKey(await contentHash("Launch", "Hi all"), await recipientHashes(["a@x.example", "b@x.example"])),
  );
  assertEquals(await heldSendKey(null, await recipientHashes(["a@x.example"])), null);
  assertEquals(await heldSendKey(hash, []), null);
});

Deno.test("a hold from the gate carries the key of the send it held", async () => {
  const db: BrakeDb = {
    rpc: () =>
      Promise.resolve({
        data: { decision: "hold", retry_at: "2026-11-17T12:00:00Z", newly_tripped: true },
        error: null,
      }),
  };
  const send = {
    workspaceId: "w",
    inboxId: "i",
    messages: 1,
    subject: "S",
    body: "B",
    recipients: ["a@x.example"],
    humanApproved: false,
  };
  const decision = await checkOutboundBrakes(db, send);
  assertEquals(decision.kind, "hold");
  if (decision.kind === "hold") {
    assertEquals(
      decision.holdKey,
      await heldSendKey(await contentHash("S", "B"), await recipientHashes(["a@x.example"])),
    );
  }
});

Deno.test("queueSendApproval returns the pending request for a repeat before writing anything", () => {
  const queue = body("queueSendApproval");
  const lookup = queue.indexOf("await findPendingHeldSend(inbox.id, operation, holdKey)");
  assert(lookup > 0, "it looks for a pending copy");
  assert(lookup < queue.indexOf("encryptForStorage("), "before anything is encrypted or inserted");
  assert(/alreadyPending: true/.test(queue), "the repeat is marked as already pending");
  assert(/!sendAt/.test(queue), "scheduled sends are not folded");
  assert(/\.\.\.\(holdKey \? \{ dedupe_key: holdKey \} : \{\}\)/.test(queue), "a new request stores its key");
  assert(/"requested_by", "dedupe_key"\]/.test(queue), "the key column is droppable");
});

Deno.test("only a pending, unexpired request with the same key, inbox and operation is reused", () => {
  const find = body("findPendingHeldSend");
  for (
    const filter of [
      `.eq("inbox_id", inboxId)`,
      `.eq("operation", operation)`,
      `.eq("status", "pending")`,
      `.eq("dedupe_key", holdKey)`,
      `.gt("expires_at"`,
    ]
  ) {
    assert(find.includes(filter), filter);
  }
});

Deno.test("the held message no longer invites a retry", () => {
  const held = body("brakeHeldPayload");
  assert(!/send it again\$\{when\}/.test(held), "no 'send it again later'");
  assert(/Do not send it again/.test(held));
  assert(/already_pending: true/.test(held));
});

Deno.test("the migration and the self-host schema add the same column", () => {
  for (const sql of [MIGRATION, SELF_HOST]) {
    assert(/ADD COLUMN IF NOT EXISTS dedupe_key text/.test(sql));
    assert(/send_approvals_pending_dedupe_idx/.test(sql));
  }
});
