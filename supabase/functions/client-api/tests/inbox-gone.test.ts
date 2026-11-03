// A disconnected inbox must not keep being served from client-api's caches.
// The executor answers inbox_not_found (or inbox_needs_reconnect); runExecutor
// then drops the cached row and tells the app, which drops the workspace's
// cached inbox list. Other isolates keep theirs for at most the 60 s TTL.
import { assertEquals } from "jsr:@std/assert@1";
import { InboxRowCache, type MailEnv, runExecutor } from "../mail/run.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const INBOX = "22222222-2222-4222-8222-222222222222";

function env(code: string, gone: string[]): MailEnv {
  const inboxes = new InboxRowCache();
  // deno-lint-ignore no-explicit-any
  inboxes.remember({ id: INBOX, workspace_id: WORKSPACE, status: "active", provider: "imap" } as any);
  return {
    // deno-lint-ignore no-explicit-any
    mcp: {
      dispatchExecutor: () =>
        Promise.resolve({
          result: { isError: true, content: [{ type: "text", text: "gone" }] },
          logStatus: "error",
          logErrorCode: code,
        }),
    } as any,
    // deno-lint-ignore no-explicit-any
    pool: { arrival: () => 0 } as any,
    inboxes,
    // deno-lint-ignore no-explicit-any
    apiKey: { id: "k", workspace_id: WORKSPACE, scopes: ["read:email"], inbox_ids: null } as any,
    canWrite: true,
    onInboxGone: (id) => gone.push(id),
  };
}

const timings = () => ({ providerMs: 0, connectMs: 0, imapDials: 0, imapReuses: 0 });

for (const code of ["inbox_not_found", "inbox_needs_reconnect"]) {
  Deno.test(`${code}: the cached row is dropped and the app is told`, async () => {
    const gone: string[] = [];
    const e = env(code, gone);
    await runExecutor(e, { tool: "email_read", args: { action: "list" } }, { inboxId: INBOX, flow: {}, timings: timings() });
    assertEquals(e.inboxes.get(INBOX, WORKSPACE), null);
    assertEquals(gone, [INBOX]);
  });
}

Deno.test("an ordinary tool error keeps the cached row", async () => {
  const gone: string[] = [];
  const e = env("provider_error", gone);
  await runExecutor(e, { tool: "email_read", args: { action: "list" } }, { inboxId: INBOX, flow: {}, timings: timings() });
  assertEquals(e.inboxes.get(INBOX, WORKSPACE)?.id, INBOX);
  assertEquals(gone, []);
});
