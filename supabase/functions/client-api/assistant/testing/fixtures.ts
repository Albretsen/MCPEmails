/* Recorded runs of the REAL engine, for the web client's tests.
 *
 * Each scenario posts a request body exactly as the client sends it to
 * `handleAssistantRun` (the real HTTP handler: request parsing, the real
 * loop, the real SSE encoding) with the scripted provider and the in-memory
 * mailbox from ./fakes.ts, and captures the response BYTES.
 *
 * The captures live in apps/client/src/api/http/fixtures/*.sse and are parsed
 * by the client's tests through its real transport and store. So when the
 * engine changes what it emits, `fixtures_test.ts` here fails until the
 * captures are regenerated, and then the client's tests say whether the
 * client still handles it:
 *
 *   deno run --node-modules-dir=none --allow-read --allow-write \
 *     supabase/functions/client-api/assistant/testing/fixtures.ts
 */

import { LlmError } from "../llm/types.ts";
import { handleAssistantRun } from "../mod.ts";
import { callTools, FakeMailbox, FakeProvider, INBOX_A, makeDeps, type Round, say } from "./fakes.ts";

export interface Scenario {
  name: string;
  /** The request body, as the client's transport builds it. */
  body: Record<string, unknown>;
  rounds: Round[];
  allowanceOk?: boolean;
  limits?: Record<string, number>;
}

const key = (id: string, folder = "INBOX") => ({ inbox_id: INBOX_A, message_id: id, folder });
const context = (keys: unknown[] = [], extra: Record<string, unknown> = {}) => ({ keys, timezone: "Europe/Oslo", ...extra });

export const SCENARIOS: Scenario[] = [
  {
    // One attached email: pre-read before the first model round, then an answer.
    name: "read-and-answer",
    body: { text: "What does Maya need from me?", context: context([key("m1")]), conversation: null },
    rounds: [say("Maya Chen needs you to confirm by Friday whether to keep 40 seats or drop to 30.")],
  },
  {
    // A list, then a batch move: mail_effect with new ids, an undoable summary, a folder chip.
    name: "move-receipts",
    body: { text: "Move my receipts to Receipts", context: context(), conversation: null },
    rounds: [
      callTools([{ name: "email_read", args: { action: "list", inbox_id: INBOX_A, folder: "inbox" } }, { name: "folder_list", args: { inbox_id: INBOX_A } }]),
      callTools([{ name: "email_organize", args: { action: "move_batch", inbox_id: INBOX_A, message_ids: ["m2", "m3"], destination_folder_id: "Receipts" } }]),
      say("I moved the two receipts to Receipts."),
    ],
  },
  {
    // The attached email is archived: its origin folder came with the context key.
    name: "archive-attached",
    body: { text: "Archive this", context: context([key("m6")]), conversation: null },
    rounds: [
      callTools([{ name: "email_organize", args: { action: "archive", inbox_id: INBOX_A, message_id: "m6" } }]),
      say("Archived."),
    ],
  },
  {
    // A reply is written into the compose view, then a send is requested: the run ENDS waiting.
    name: "draft-and-request-send",
    body: { text: "Reply that we keep 40 seats and send it", context: context([key("m1")]), conversation: null },
    rounds: [
      callTools([{
        name: "write_draft",
        args: { kind: "reply", to: "maya@lumenworks.example", cc: "tomas@northwind.example", subject: "Re: Q4 renewal terms", body: "Hi Maya,\n\nWe will keep the 40 seats.\n\nBest,\nAda" },
        chunk: 23,
      }]),
      callTools([{ name: "request_send", args: {} }]),
    ],
  },
  {
    // The open draft is edited: a word diff, then the final body.
    name: "edit-draft",
    body: {
      text: "Make it shorter",
      context: context([], { notes: [{ type: "approval", approval_id: "run_t_ap1", decision: "edited" }] }),
      conversation: null,
      draft: {
        inbox_id: INBOX_A,
        kind: "reply",
        to: "maya@lumenworks.example",
        cc: "",
        subject: "Re: Q4 renewal terms",
        body: "Hi Maya,\n\nWe will keep the 40 seats.\n\nBest,\nAda",
        reply_to: { inbox_id: INBOX_A, message_id: "m1" },
      },
    },
    rounds: [
      callTools([{ name: "edit_draft", args: { body: "Hi Maya,\n\nWe keep 40 seats.\n\nAda" } }]),
      say("Shortened."),
    ],
  },
  {
    // A change lands, then the provider fails: `error`, and `done` still follows with the undo summary.
    name: "error-after-change",
    body: { text: "Archive the newsletter and summarise the rest", context: context(), conversation: null },
    rounds: [
      callTools([{ name: "email_read", args: { action: "list", inbox_id: INBOX_A, folder: "inbox" } }]),
      callTools([{ name: "email_organize", args: { action: "archive", inbox_id: INBOX_A, message_id: "m4" } }]),
      // The failing round reports its usage. Left unreported, the engine
      // estimates it from the size of the prompt and tool definitions, and the
      // recorded `done.usage` then went stale on every prompt edit (the
      // estimate itself is covered by loop_test's abort tests). These are the
      // numbers the fixture was recorded with.
      {
        events: [
          { type: "text_delta", text: "The rest of your inbox " },
          { type: "usage", inputTokens: 2805, outputTokens: 6, cachedInputTokens: 0 },
        ],
        then: "throw",
        error: new LlmError("overloaded", { retryable: true }),
      },
    ],
  },
  {
    // The month's allowance is used up: one `error`, nothing else, no `done`.
    name: "allowance-exhausted",
    body: { text: "Anything urgent?", context: context(), conversation: null },
    rounds: [],
    allowanceOk: false,
  },
  {
    // A limit ends the run: `done.stopped`, with the engine's own sentence.
    name: "stopped-max-rounds",
    body: { text: "Go through everything", context: context(), conversation: null },
    rounds: [callTools([{ name: "email_read", args: { action: "list", inbox_id: INBOX_A, folder: "inbox" } }])],
    limits: { maxRounds: 1 },
  },
];

/** Runs one scenario through the real handler and returns the SSE bytes as text. */
export async function capture(scenario: Scenario): Promise<string> {
  const { deps } = makeDeps({ mailbox: new FakeMailbox(), allowanceOk: scenario.allowanceOk });
  const request = new Request("https://client-api.invalid/assistant/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scenario.body),
  });
  const response = await handleAssistantRun(request, deps, {
    provider: new FakeProvider(scenario.rounds),
    model: "gpt-5.4-mini",
    runId: "run_t",
    nonce: "n0nce",
    now: () => Date.parse("2026-10-03T09:00:00Z"),
    limits: { editHoldMs: 0, ...scenario.limits },
  });
  if (response.status !== 200) throw new Error(`${scenario.name}: HTTP ${response.status} ${await response.text()}`);
  return await response.text();
}

export const FIXTURE_DIR = new URL("../../../../../apps/client/src/api/http/fixtures/", import.meta.url);

if (import.meta.main) {
  await Deno.mkdir(FIXTURE_DIR, { recursive: true });
  for (const scenario of SCENARIOS) {
    const text = await capture(scenario);
    await Deno.writeTextFile(new URL(`${scenario.name}.sse`, FIXTURE_DIR), text);
    await Deno.writeTextFile(new URL(`${scenario.name}.request.json`, FIXTURE_DIR), JSON.stringify(scenario.body, null, 2) + "\n");
    console.log(`${scenario.name}: ${text.length} bytes`);
  }
}
