import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { attachResultNote } from "./result-notes.ts";
import {
  maybeAttachOnboardingWelcome,
  mayBeFirstValueCall,
  ONBOARDING_WELCOME_TEXT,
} from "./onboarding-welcome.ts";

const INBOX = "11111111-1111-1111-1111-111111111111";
const fresh = { analytics_first_tool_used_at: null, onboarding_value_activated_at: null };

function db(answer: { data?: unknown; error?: { message: string } | null } = { data: true }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
    },
  };
}

const quiet = () => {};

Deno.test("the welcome line is short, names two next asks, and never a price or a link", () => {
  assert(ONBOARDING_WELCOME_TEXT.length < 300);
  assert(/draft replies/.test(ONBOARDING_WELCOME_TEXT));
  assert(/morning brief/.test(ONBOARDING_WELCOME_TEXT));
  assert(!/\$|€|price|plan|upgrade|https?:/i.test(ONBOARDING_WELCOME_TEXT));
  assert(!ONBOARDING_WELCOME_TEXT.includes("—"));
});

Deno.test("only a successful real-inbox call on a not-yet-activated workspace may ask", () => {
  assert(mayBeFirstValueCall({ markers: fresh, succeeded: true, inboxId: INBOX, toolName: "email_read" }));
  assert(!mayBeFirstValueCall({ markers: fresh, succeeded: true, inboxId: INBOX, toolName: "inbox_list" }));
  assert(!mayBeFirstValueCall({ markers: fresh, succeeded: true, inboxId: null, toolName: "email_read" }));
  assert(!mayBeFirstValueCall({ markers: fresh, succeeded: false, inboxId: INBOX, toolName: "email_read" }));
  assert(!mayBeFirstValueCall({ markers: undefined, succeeded: true, inboxId: INBOX, toolName: "email_read" }));
  assert(!mayBeFirstValueCall({
    markers: { analytics_first_tool_used_at: "2026-10-26T00:00:00Z", onboarding_value_activated_at: "2026-10-26T00:00:00Z" },
    succeeded: true,
    inboxId: INBOX,
    toolName: "email_read",
  }));
});

Deno.test("attached once, when the database claim says so", async () => {
  const notes: string[] = [];
  const won = db({ data: true });
  assertEquals(await maybeAttachOnboardingWelcome({
    db: won, workspaceId: "ws", markers: fresh, succeeded: true, inboxId: INBOX, toolName: "email_read",
    attach: (n) => notes.push(n), log: quiet,
  }), true);
  assertEquals(won.calls, [{ fn: "claim_onboarding_welcome", args: { p_workspace_id: "ws" } }]);
  assertEquals(notes, [ONBOARDING_WELCOME_TEXT]);

  const lost = db({ data: false });
  assertEquals(await maybeAttachOnboardingWelcome({
    db: lost, workspaceId: "ws", markers: fresh, succeeded: true, inboxId: INBOX, toolName: "email_read",
    attach: (n) => notes.push(n), log: quiet,
  }), false);
  assertEquals(notes.length, 1);
});

Deno.test("no query at all for an activated workspace, and an error never fails the call", async () => {
  const none = db();
  await maybeAttachOnboardingWelcome({
    db: none, workspaceId: "ws",
    markers: { analytics_first_tool_used_at: "x", onboarding_value_activated_at: "x" },
    succeeded: true, inboxId: INBOX, toolName: "email_read", attach: () => {}, log: quiet,
  });
  assertEquals(none.calls.length, 0);

  const broken = db({ error: { message: "boom" } });
  const notes: string[] = [];
  assertEquals(await maybeAttachOnboardingWelcome({
    db: broken, workspaceId: "ws", markers: fresh, succeeded: true, inboxId: INBOX, toolName: "email_read",
    attach: (n) => notes.push(n), log: quiet,
  }), false);
  assertEquals(notes.length, 0);
});

Deno.test("the line lands on the tool result the model reads", async () => {
  const response = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ messages: [] }) }], structuredContent: { messages: [] } },
  };
  await maybeAttachOnboardingWelcome({
    db: db({ data: true }), workspaceId: "ws", markers: fresh, succeeded: true, inboxId: INBOX, toolName: "email_read",
    attach: (n) => attachResultNote(response, n), log: quiet,
  });
  assert(response.result.content[0].text.includes("morning brief"));
});
