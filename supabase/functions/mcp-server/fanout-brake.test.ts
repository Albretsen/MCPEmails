// ---------------------------------------------------------------------------
// Fan-out brake (outbound-brakes.ts).
//
// One normalized subject+body to more than 25 distinct recipients within an
// hour from one inbox holds further sends from that inbox in the approval
// queue until the end of the UTC day. Only SHA-256 digests reach the database.
// The SQL counting is covered by supabase/tests/outbound_abuse_brakes.sql.
//
// Run: deno test --allow-read supabase/functions/mcp-server/fanout-brake.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  type BrakeDb,
  checkOutboundBrakes,
  contentHash,
  FANOUT_RECIPIENT_LIMIT,
  FANOUT_WINDOW_MS,
  normalizeContent,
  normalizeRecipient,
  parseGateAnswer,
  recipientHashes,
} from "./outbound-brakes.ts";

const SOURCE = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const MIGRATION = await Deno.readTextFile(
  new URL("../../migrations/20261024130000_outbound_abuse_brakes.sql", import.meta.url),
);

function recordingDb(answer: unknown = { decision: "allow" }) {
  const calls: Record<string, unknown>[] = [];
  const db: BrakeDb = {
    rpc(_fn, args) {
      calls.push(args);
      return Promise.resolve({ data: answer, error: null });
    },
  };
  return { db, calls };
}

Deno.test("the limit is more than 25 distinct recipients in one hour", () => {
  assertEquals(FANOUT_RECIPIENT_LIMIT, 25);
  assertEquals(FANOUT_WINDOW_MS, 3_600_000);
  assert(/IF v_distinct > p_fanout_limit THEN/.test(MIGRATION), "strictly more than the limit trips it");
});

Deno.test("content is normalized: case, Unicode form and whitespace do not make a new message", async () => {
  assertEquals(normalizeContent("  Big  NEWS ", "Hello\n\n  World"), "big news\nhello world");
  assertEquals(await contentHash("Big News", "Hello World"), await contentHash("big   news", "hello\nworld"));
  assertEquals(
    await contentHash("Caf\u00e9", "x"),
    await contentHash("Cafe\u0301", "x"),
    "NFKC folds composed and decomposed forms",
  );
  assertNotEquals(await contentHash("Big News", "Hello Ann"), await contentHash("Big News", "Hello Bob"));
  assertEquals(await contentHash("", ""), null, "an empty message has no hash and skips the brake");
});

Deno.test("recipients are normalized and de-duplicated before hashing", async () => {
  assertEquals(normalizeRecipient(" Ann Example <ANN@Example.test> "), "ann@example.test");
  const hashes = await recipientHashes(["ann@example.test", "Ann <ANN@example.test>", "bob@example.test", " "]);
  assertEquals(hashes.length, 2);
  for (const h of hashes) assert(/^[0-9a-f]{64}$/.test(h), h);
});

Deno.test("only digests reach the database: never the subject, body or an address", async () => {
  const { db, calls } = recordingDb();
  await checkOutboundBrakes(db, {
    workspaceId: "w",
    inboxId: "i",
    messages: 1,
    subject: "Secret launch plan",
    body: "The password is hunter2",
    recipients: ["ceo@example.test", "cfo@example.test"],
    humanApproved: false,
  });
  const sent = JSON.stringify(calls[0]);
  for (const leak of ["Secret", "launch", "hunter2", "ceo@", "example.test"]) {
    assert(!sent.includes(leak), `"${leak}" must not leave the edge function`);
  }
  assert(/^[0-9a-f]{64}$/.test(String(calls[0].p_content_hash)));
  assertEquals((calls[0].p_recipient_hashes as string[]).length, 2);
  // The table can only hold hex digests.
  assert(/content_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(MIGRATION));
  assert(/recipient_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(MIGRATION));
});

Deno.test("an approved send skips the fan-out check but is still counted", async () => {
  const { db, calls } = recordingDb();
  await checkOutboundBrakes(db, {
    workspaceId: "w",
    inboxId: "i",
    messages: 1,
    subject: "s",
    body: "b",
    recipients: ["a@example.test"],
    humanApproved: true,
  });
  assertEquals(calls[0].p_human_approved, true);
  assert(/IF NOT COALESCE\(p_human_approved, false\) THEN/.test(MIGRATION), "the SQL skips fan-out for it");
});

Deno.test("a hold answer is a hold, with its end and whether it just tripped", () => {
  assertEquals(
    parseGateAnswer({ decision: "hold", retry_at: "2026-10-25T00:00:00+00:00", newly_tripped: true }),
    { kind: "hold", retryAt: "2026-10-25T00:00:00+00:00", newlyTripped: true },
  );
  assertEquals(parseGateAnswer({ decision: "hold" }), { kind: "hold", retryAt: null, newlyTripped: false });
  assert(
    /date_trunc\('day', v_now AT TIME ZONE 'UTC'\) \+ interval '1 day'/.test(MIGRATION),
    "held until the end of the UTC day",
  );
});

Deno.test("a held send goes to the approval queue (held, never dropped)", () => {
  for (const handler of ["executeSendEmail", "executeReplyToEmail", "executeForwardEmail", "executeSendDraft"]) {
    const start = SOURCE.indexOf(`async function ${handler}(`);
    const body = SOURCE.slice(start, SOURCE.indexOf("\nasync function ", start + 1));
    assert(
      /queueSendApproval\(\s*brake(?:\.hold|Hold) \? brakeHeldInbox\(/.test(body),
      `${handler} queues the send for approval while the inbox is held`,
    );
  }
  assert(
    /function brakeHeldInbox\(inbox: InboxRow\): InboxRow \{\s*return \{ \.\.\.inbox, send_approval_required: true \};/
      .test(SOURCE),
    "holding reuses the existing approval gate (send_approval_required)",
  );
  assert(
    /if \(decision\.newlyTripped\) \{\s*await notifyBrakeTripped\(/.test(SOURCE),
    "the operator is notified once, when the hold starts",
  );
  const dispatch = SOURCE.slice(SOURCE.indexOf("async function handleScheduledDispatch("));
  assert(
    /if \(brake\.kind === "hold"\) \{\s*throw new ScheduledDispatchHeld/.test(dispatch),
    "a scheduled send caught by the hold stays pending",
  );
});

Deno.test("the forward and reply wiring hash something stable when content is not read", () => {
  assert(SOURCE.includes("subject: `forward\\n${[...messageIds].sort().join(\"\\n\")}`"), "forward hashes the ids");
  assert(SOURCE.includes("recipients: [`thread:${String(messageId)}`, ...extraCc, ...extraBcc]"), "reply uses the thread");
});
