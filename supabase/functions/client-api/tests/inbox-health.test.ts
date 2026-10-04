// Reconnect errors written for the person, `/session` inbox status, and the
// refused-login memory that reaches other isolates through the inbox row.

import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Membership } from "../auth.ts";
import { InboxHealth, loginRefusedAt, loginRefusedMarker, REFUSAL_WINDOW_MS } from "../mail/health.ts";
import type { InboxRow } from "../seam.ts";
import { fakeSeam, fakeStore, INBOX_ID, membership, mintHs256, ok, request, SECOND_INBOX_ID, testApp, toolError, WORKSPACE_ID } from "./helpers.ts";
import { FakeDialPool, harness, imapInbox, imapServer, realApp } from "./real-seam.ts";

const PASSWORD_TEXT = "This mailbox's password was refused by the mail server. Reconnect it in the dashboard.";
const OAUTH_TEXT = "Access to this mailbox has expired or was revoked. Reconnect it in the dashboard.";
const AGENT_TEXT = (provider: string) =>
  `Unable to access the ${provider} inbox: its OAuth token has been revoked or expired, so the inbox has been marked 'error'. ` +
  "Ask the user to reconnect it by opening this link in their browser (they may need to sign in to MCP Emails first): https://mcpemails.com/x";

const noHandler: harness.ProviderHandler = (call) => harness.json({ error: `unexpected provider call ${call.url}` }, 500);
const refuse = () => {
  const error = new Error("IMAP authentication failed: Authentication failed");
  error.name = "ImapAuthError";
  throw error;
};
const working = imapServer([{ name: "INBOX", attrs: ["\\HasNoChildren"], messages: [] }]);

function withRows(rows: Array<Record<string, unknown>>): Membership {
  return membership({ inbox_rows: rows as unknown as InboxRow[] });
}

// ── 1. reconnect errors read as written for a person ────────────────────────

Deno.test("reconnect error: a refused IMAP password is said in the person's terms, codes unchanged", async () => {
  const pool = new FakeDialPool(refuse);
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  for (const [op, args] of [["list", { folder: "inbox" }], ["status", { folders: ["inbox"] }]] as const) {
    const { value } = await harness.runTool(inbox, noHandler, () => app.mail(op, args));
    assertEquals(
      [value.status, value.body.error.code, value.body.error.tool_code, value.body.error.message],
      [409, "reconnect_required", "auth_failed", PASSWORD_TEXT],
      op,
    );
  }
  await pool.closeAll();
});

Deno.test("reconnect error: the tool layer's agent-facing text never reaches the person, per provider", async () => {
  const token = await mintHs256();
  const cases: Array<[string, string]> = [
    ["gmail", OAUTH_TEXT],
    ["outlook", OAUTH_TEXT],
    ["imap", PASSWORD_TEXT],
    ["fastmail", PASSWORD_TEXT],
  ];
  for (const [provider, expected] of cases) {
    const seam = fakeSeam();
    seam.respond = () => toolError("auth_failed", AGENT_TEXT(provider));
    const { handle } = testApp({ seam });
    const response = await handle(request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID, args: {} } }));
    const { error } = await response.json();
    assertEquals([response.status, error.code, error.tool_code, error.retryable], [409, "reconnect_required", "auth_failed", false]);
    assertEquals(error.message, expected, provider);
    assert(!/OAuth token|Ask the user|—/.test(error.message));
  }
  // A text that names no provider still gets a sentence for a person.
  const seam = fakeSeam();
  seam.respond = () => toolError("auth_failed", "something else entirely");
  const { handle } = testApp({ seam });
  const response = await handle(request("/mail", { token, body: { op: "list", inbox_id: INBOX_ID, args: {} } }));
  assertEquals((await response.json()).error.message, "This mailbox needs to be reconnected. Reconnect it in the dashboard.");
});

Deno.test("reconnect error: a batch slot carries the same sentence", async () => {
  const token = await mintHs256();
  const seam = fakeSeam();
  seam.respond = () => toolError("auth_failed", AGENT_TEXT("gmail"));
  const { handle } = testApp({ seam });
  const response = await handle(request("/mail/batch", { token, body: { calls: [{ op: "list", inbox_id: INBOX_ID, args: {} }] } }));
  const body = await response.json();
  assertEquals([body.results[0].ok, body.results[0].error.code, body.results[0].error.message], [false, "reconnect_required", OAUTH_TEXT]);
});

// ── 3. the refusal reaches other isolates through the row ────────────────────

Deno.test("refused login: recorded on the row once, and the same isolate does not dial again", async () => {
  const pool = new FakeDialPool(refuse);
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  await harness.runTool(inbox, noHandler, async () => {
    assertEquals((await app.mail("list", { folder: "inbox" })).status, 409);
    const again = await app.mail("list", { folder: "inbox" });
    assertEquals([again.status, again.body.error.code, again.body.error.message], [409, "reconnect_required", PASSWORD_TEXT]);
  });
  assertEquals(pool.connects, 1, "the second request never asked the pool for a connection");
  assertEquals(app.store.loginMarks, [{ op: "mark", inboxId: harness.INBOX_ID, workspaceId: harness.WORKSPACE }]);
  const lines = app.logs.filter((l) => l.event === "request").map((l) => l.fields["imap_dials"]);
  assertEquals(lines, [1, 0]);
  // The log line carries ids only.
  const noted = app.logs.find((l) => l.event === "imap_login_refused")!;
  assertEquals(Object.keys(noted.fields).sort(), ["inbox_id", "request_id", "workspace_id"]);
  await pool.closeAll();
});

Deno.test("refused login: a FRESH isolate that loads the marked row answers reconnect_required without dialling", async () => {
  const pool = new FakeDialPool(refuse);
  const app = await realApp({ pool });
  const inbox = await imapInbox({ last_error: loginRefusedMarker(Date.now() - 30_000) });
  app.store.rows = [withRows([inbox])].map((m) => ({ ...m, workspace_id: harness.WORKSPACE }));
  const { value } = await harness.runTool(inbox, noHandler, () => app.mail("list", { folder: "inbox" }));
  assertEquals([value.status, value.body.error.code, value.body.error.tool_code, value.body.error.message], [
    409,
    "reconnect_required",
    "auth_failed",
    PASSWORD_TEXT,
  ]);
  assertEquals([pool.connects, pool.servers.length], [0, 0], "no connection was asked for, none was dialled");
  assertEquals(app.store.loginMarks, [], "nothing new to record");
  // status and batch take the same early exit.
  const status = await harness.runTool(inbox, noHandler, () => app.mail("status", { folders: ["inbox"] }));
  assertEquals([status.value.status, status.value.body.error.code], [409, "reconnect_required"]);
  assertEquals(pool.connects, 0);
  await pool.closeAll();
});

Deno.test("refused login: after the window one login is tried, and a login that works clears the marker", async () => {
  const pool = new FakeDialPool(working);
  const app = await realApp({ pool });
  const inbox = await imapInbox({ last_error: loginRefusedMarker(Date.now() - REFUSAL_WINDOW_MS - 1_000) });
  app.store.rows = [{ ...withRows([inbox]), workspace_id: harness.WORKSPACE }];
  const { value } = await harness.runTool(inbox, noHandler, () => app.mail("list", { folder: "inbox" }));
  assertEquals(value.status, 200, JSON.stringify(value.body));
  assertEquals(pool.servers.length, 1);
  assertEquals(app.store.loginMarks, [{ op: "clear", inboxId: harness.INBOX_ID, workspaceId: harness.WORKSPACE }]);
  await pool.closeAll();
});

Deno.test("refused login: a healthy mailbox writes nothing to its row", async () => {
  const pool = new FakeDialPool(working);
  const app = await realApp({ pool });
  const inbox = await imapInbox();
  const { value } = await harness.runTool(inbox, noHandler, () => app.mail("list", { folder: "inbox" }));
  assertEquals(value.status, 200);
  assertEquals(app.store.loginMarks, []);
  await pool.closeAll();
});

Deno.test("health: reconnecting (new stored credentials) or a cleared marker ends the refusal; the marker round-trips", () => {
  let now = Date.parse("2026-10-04T12:00:00Z");
  const health = new InboxHealth(() => now);
  const row = { id: INBOX_ID, workspace_id: WORKSPACE_ID, provider: "imap", status: "active", imap_host: "h", imap_port: 993, imap_username: null, imap_password: "cipher-1" };
  const marker = loginRefusedMarker(now);
  assertEquals(loginRefusedAt(marker), now);
  assertEquals(loginRefusedAt("The app password was rejected. Reconnect this inbox to restore access."), null);
  assert(!/—/.test(marker));

  health.observe({ ...row, last_error: marker });
  assertEquals(health.state(INBOX_ID, WORKSPACE_ID), { status: "reconnect_required", status_reason: "password_refused" });
  assertEquals(health.state(INBOX_ID, "another-workspace"), { status: "ok", status_reason: null }, "nothing is said about another workspace's inbox");

  // Reconnected: the stored password changed and the route cleared last_error.
  health.observe({ ...row, imap_password: "cipher-2", last_error: null });
  assertEquals(health.state(INBOX_ID, WORKSPACE_ID), { status: "ok", status_reason: null });

  // Marked again, then "Check connection" clears last_error with the same credentials.
  health.observe({ ...row, imap_password: "cipher-2", last_error: marker });
  assertEquals(health.refused(INBOX_ID), true);
  health.observe({ ...row, imap_password: "cipher-2", last_error: null });
  assertEquals(health.refused(INBOX_ID), false);

  // A refusal seen here expires by itself.
  health.noteRefused(INBOX_ID);
  assertEquals(health.refused(INBOX_ID), true);
  now += REFUSAL_WINDOW_MS + 1;
  assertEquals(health.refused(INBOX_ID), false);

  // A row the tool layer loaded (no last_error column) does not undo a refusal.
  health.noteRefused(INBOX_ID);
  const { ...withoutColumn } = { ...row, imap_password: "cipher-2" };
  health.observe(withoutColumn);
  assertEquals(health.refused(INBOX_ID), true);
});

// ── 2. /session says which inboxes need attention ────────────────────────────

Deno.test("GET /session: every inbox carries status and status_reason, and no mailbox is contacted", async () => {
  const token = await mintHs256();
  const listed = (id: string, extra: Record<string, unknown> = {}) => ({
    inbox_id: id,
    email_address: `${id.slice(0, 4)}@example.test`,
    display_name: "Listed",
    provider: "imap",
    service: null,
    sender_identities: [],
    sender_identity_status: "available",
    ...extra,
  });
  const GMAIL_SCOPE = "66666666-6666-4666-8666-666666666666";
  const REVOKED = "77777777-7777-4777-8777-777777777777";
  const NO_MAILBOX = "88888888-8888-4888-8888-888888888888";
  const PENDING = "99999999-9999-4999-8999-999999999999";
  const row = (id: string, extra: Record<string, unknown>) => ({
    id,
    workspace_id: WORKSPACE_ID,
    provider: "imap",
    status: "active",
    email_address: `${id.slice(0, 4)}@example.test`,
    display_name: null,
    service: null,
    last_error: null,
    imap_host: "imap.example.test",
    imap_port: 993,
    imap_username: null,
    imap_password: "cipher",
    ...extra,
  });
  const seam = fakeSeam();
  seam.respond = (call) =>
    call.tool === "inbox_list"
      ? ok({
        inboxes: [
          listed(INBOX_ID),
          listed(SECOND_INBOX_ID),
          listed(GMAIL_SCOPE, { provider: "gmail", sender_identity_status: "reconnect_required" }),
        ],
      })
      : ok({});
  const pool = new FakeDialPool(refuse);
  const store = fakeStore([withRows([
    row(INBOX_ID, {}),
    row(SECOND_INBOX_ID, { last_error: loginRefusedMarker(Date.now() - 5_000) }),
    row(GMAIL_SCOPE, { provider: "gmail" }),
    row(REVOKED, { provider: "gmail", status: "error", last_error: "Gmail refresh token revoked", display_name: "Work" }),
    row(NO_MAILBOX, { provider: "outlook", status: "error", last_error: "This Microsoft account has no Outlook / Exchange Online mailbox that Microsoft Graph can reach." }),
    row(PENDING, { status: "pending" }),
  ])]);
  const { handle, logs } = testApp({ seam, store, pool });
  const response = await handle(request("/session", { token }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(
    body.inboxes.map((i: Record<string, unknown>) => [i.inbox_id, i.status, i.status_reason]),
    [
      [INBOX_ID, "ok", null],
      [SECOND_INBOX_ID, "reconnect_required", "password_refused"],
      [GMAIL_SCOPE, "reconnect_required", "sender_identity"],
      [REVOKED, "reconnect_required", "access_revoked"],
      [NO_MAILBOX, "error", "no_mailbox"],
    ],
    "a pending row is not an inbox yet; rows in error are listed after the active ones",
  );
  const revoked = body.inboxes[3];
  assertEquals(
    [revoked.email_address, revoked.display_name, revoked.provider, revoked.sender_identity_status, revoked.sender_identities.length],
    ["7777@example.test", "Work", "gmail", "unavailable", 1],
  );
  // Nothing of the row leaks: no credentials, no last_error text.
  assert(!/cipher|imap_password|last_error|refresh token/.test(JSON.stringify(body)));
  assertEquals(pool.connects, 0, "no mailbox connection was opened to find out");
  assertEquals(logs.find((l) => l.event === "request")!.fields["inboxes_attention"], 4);

  // The same knowledge refuses a mail call for a row in error, before any executor runs.
  const calls = (seam as unknown as { calls: unknown[] }).calls.length;
  const mail = await handle(request("/mail", { token, body: { op: "list", inbox_id: REVOKED, args: {} } }));
  const error = (await mail.json()).error;
  assertEquals([mail.status, error.code, error.tool_code, error.message], [
    409,
    "reconnect_required",
    "auth_failed",
    "Access to this mailbox has expired or was revoked. Reconnect it in the dashboard.",
  ]);
  const none = await handle(request("/mail", { token, body: { op: "list", inbox_id: NO_MAILBOX, args: {} } }));
  assertEquals((await none.json()).error.tool_code, "outlook_no_mailbox");
  assertEquals((seam as unknown as { calls: unknown[] }).calls.length, calls);
  await pool.closeAll();
});
