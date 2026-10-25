// inbox_list fetches IMAP Send As aliases BESIDE the inbox query, not after
// it (2026-10-20). PR #135 added the alias lookup as a second sequential round
// trip and inbox_list p50 went from 145 to 290 ms. These pin both halves: the
// two queries are in flight together, and the listing is unchanged.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as harness from "./provider-call-harness.ts";

const server = await import("./index.ts") as unknown as {
  dispatchExecutor: (
    name: string,
    args: unknown,
    apiKey: unknown,
  ) => Promise<{ result: { isError?: boolean; content: { text: string }[] }; logStatus: string } | null>;
};

const OTHER_INBOX = "55555555-5555-4555-8555-555555555555";

async function imapInbox(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await harness.inboxRow("gmail", {
    provider: "imap",
    email_address: "owner@example.com",
    oauth_access_token: null,
    oauth_refresh_token: null,
    oauth_token_expires_at: null,
    imap_host: "imap.fake-server.example",
    imap_port: 993,
    imap_password: await harness.encryptToken("app-password-invented"),
    smtp_host: "smtp.fake-server.example",
    smtp_port: 465,
    ...overrides,
  });
}

const noProvider: harness.ProviderHandler = (call) => {
  throw new Error(`no provider call expected, got ${call.method} ${call.url}`);
};

async function listInboxes(dbRows: Record<string, unknown[]>, inboxes: Record<string, unknown>[]) {
  const { value, world } = await harness.runToolWithInboxes(
    inboxes,
    noProvider,
    () => server.dispatchExecutor("inbox_list", {}, harness.API_KEY),
    dbRows,
  );
  assert(value);
  assertEquals(value.logStatus, "success");
  const listed = (JSON.parse(value.result.content[0].text) as { inboxes: Array<Record<string, any>> }).inboxes;
  return { listed, world };
}

Deno.test("inbox_list asks for inboxes and aliases in the same round trip", async () => {
  const { world } = await listInboxes({}, [await imapInbox()]);
  const inboxes = world.db.find((c) => c.method === "GET" && c.target === "inboxes");
  const aliases = world.db.find((c) => c.method === "GET" && c.target === "inbox_sender_aliases");
  assert(inboxes && aliases, "both queries are issued");
  assertEquals(
    aliases.answeredBefore,
    inboxes.answeredBefore,
    "the alias query must not wait for the inbox query's answer",
  );
  assert(aliases.query.includes("workspace_id=eq."), "scoped to the workspace");
  assert(aliases.query.includes("verified_at=not.is.null"), "verified aliases only");
});

Deno.test("inbox_list still lists each IMAP inbox's own verified aliases, and no one else's", async () => {
  const other = await imapInbox({ id: OTHER_INBOX, email_address: "other@example.com" });
  const gmail = await harness.inboxRow("gmail", { id: "66666666-6666-4666-8666-666666666666" });
  const { listed } = await listInboxes(
    {
      inbox_sender_aliases: [
        { inbox_id: harness.INBOX_ID, email_address: "alias@example.com", display_name: "Alias" },
        { inbox_id: OTHER_INBOX, email_address: "other-alias@example.com", display_name: null },
        // An alias row on a Gmail inbox is never read: Gmail lists its own.
        { inbox_id: "66666666-6666-4666-8666-666666666666", email_address: "x@example.com", display_name: null },
      ],
    },
    [await imapInbox(), other, gmail],
  );
  const byId = new Map(listed.map((row) => [row.inbox_id, row]));
  const first = byId.get(harness.INBOX_ID)!;
  assertEquals(first.sender_identity_status, "available");
  assertEquals(
    first.sender_identities.map((s: Record<string, unknown>) => [s.email_address, s.is_primary]),
    [["owner@example.com", true], ["alias@example.com", false]],
  );
  const second = byId.get(OTHER_INBOX)!;
  assertEquals(
    second.sender_identities.map((s: Record<string, unknown>) => s.email_address),
    ["other@example.com", "other-alias@example.com"],
  );
});
