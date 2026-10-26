// Inboxes that need reconnecting are marked in the "pick an inbox" answer and
// in inbox_list, never offered as a choice. See inbox-health.ts.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  allInboxesBrokenChoice,
  buildInboxChoice,
  type ChoiceInbox,
  inboxHealthHint,
  inboxHealthStatus,
  inboxHealthWrite,
  LOGIN_REFUSED_LIKE,
  loginRefusedAt,
  loginRefusedMarker,
} from "./inbox-health.ts";
import * as clientApiHealth from "../client-api/mail/health.ts";

const APP = "https://mcpemails.com";
const reconnectUrl = (provider: string, id: string) =>
  provider === "gmail" || provider === "outlook" ? `${APP}/auth/${provider}?inbox=${id}` : `${APP}/dashboard/inboxes`;
const NO_MAILBOX = "This Microsoft account has no Exchange Online mailbox.";
const MARKER = loginRefusedMarker(Date.parse("2026-10-04T20:04:04.730Z"));

// The four inboxes from the 2026-10-26 persona test, with test addresses.
const repro: ChoiceInbox[] = [
  { id: "a1", email_address: "a@example.com", provider: "imap", status: "active", last_error: null },
  { id: "f2", email_address: "f@fastmail.example", provider: "imap", status: "active", last_error: MARKER },
  { id: "o3", email_address: "o@outlook.example", provider: "outlook", status: "active", last_error: null },
  { id: "g4", email_address: "g@gmail.example", provider: "imap", status: "active", last_error: null },
];

Deno.test("marker format is client-api's, byte for byte", () => {
  const at = Date.parse("2026-10-26T10:00:00.000Z");
  assertEquals(loginRefusedMarker(at), clientApiHealth.loginRefusedMarker(at));
  assertEquals(LOGIN_REFUSED_LIKE, clientApiHealth.LOGIN_REFUSED_LIKE);
  assertEquals(loginRefusedAt(clientApiHealth.loginRefusedMarker(at)), at);
  assertEquals(clientApiHealth.loginRefusedAt(loginRefusedMarker(at)), at);
});

Deno.test("inboxHealthStatus: error rows, the refusal marker, and everything else", () => {
  assertEquals(inboxHealthStatus({ provider: "imap", status: "active", last_error: null }), null);
  assertEquals(inboxHealthStatus({ provider: "imap", status: "active", last_error: MARKER }), "reconnect_required");
  // Any other last_error on an active row is not a reason to hide it.
  assertEquals(inboxHealthStatus({ provider: "imap", status: "active", last_error: "Sent copy failed" }), null);
  assertEquals(
    inboxHealthStatus({ provider: "gmail", status: "error", last_error: "Gmail refresh token revoked — user must reconnect." }),
    "reconnect_required",
  );
  assertEquals(inboxHealthStatus({ provider: "outlook", status: "error", last_error: NO_MAILBOX }, NO_MAILBOX), "unavailable");
  assertEquals(inboxHealthStatus({ provider: "imap", status: "pending" }), null);
});

Deno.test("repro: the refused Fastmail inbox is not in the choosable set, and is marked with its link", () => {
  const choice = buildInboxChoice(repro, reconnectUrl, NO_MAILBOX);
  const usable = choice.structuredContent.inboxes as Array<Record<string, unknown>>;
  const broken = choice.structuredContent.needs_reconnect as Array<Record<string, unknown>>;
  assertEquals(usable.map((ib) => ib.inbox_id), ["a1", "o3", "g4"]);
  assertEquals(broken, [{
    inbox_id: "f2",
    email_address: "f@fastmail.example",
    display_name: null,
    provider: "imap",
    status: "reconnect_required",
    reconnect_url: `${APP}/dashboard/inboxes`,
  }]);
  // The retry list names only usable inboxes; the broken one sits under a
  // "do not offer" line with its link.
  const [offer, warning] = choice.text.split("\n\n");
  assert(!offer.includes("f@fastmail.example"));
  assertStringIncludes(offer, "a@example.com — inbox_id: a1");
  assertStringIncludes(warning, "do not offer them as a choice");
  assertStringIncludes(warning, `f@fastmail.example — needs reconnecting: ${APP}/dashboard/inboxes`);
});

Deno.test("no broken inbox: the answer is exactly what it was before", () => {
  const healthy = repro.filter((ib) => ib.id !== "f2");
  const choice = buildInboxChoice(healthy, reconnectUrl);
  assertEquals(
    choice.text,
    "Multiple inboxes are accessible, so inbox_id (or inbox) is required. " +
      "Retry this same tool with one of the inbox_id values below — you do " +
      "not need to call any other tool first:\n" +
      "  • a@example.com — inbox_id: a1\n  • o@outlook.example — inbox_id: o3\n  • g@gmail.example — inbox_id: g4",
  );
  assertEquals(Object.keys(choice.structuredContent), ["inboxes"]);
});

Deno.test("an 'error' Gmail row links to its OAuth reconnect; a no-mailbox Outlook row gets no link", () => {
  const choice = buildInboxChoice([
    repro[0],
    { id: "g9", email_address: "g9@gmail.example", provider: "gmail", status: "error", last_error: "revoked" },
    { id: "o9", email_address: "o9@outlook.example", provider: "outlook", status: "error", last_error: NO_MAILBOX },
  ], reconnectUrl, NO_MAILBOX);
  const broken = choice.structuredContent.needs_reconnect as Array<Record<string, unknown>>;
  assertEquals(broken[0].reconnect_url, `${APP}/auth/gmail?inbox=g9`);
  assertEquals(broken[1].status, "unavailable");
  assert(!("reconnect_url" in broken[1]));
  assertStringIncludes(choice.text, "o9@outlook.example — cannot be used");
});

Deno.test("every inbox broken: nothing is offered as a choice", () => {
  const both = [repro[1], { ...repro[0], status: "error" }];
  const choice = buildInboxChoice(both, reconnectUrl);
  assertEquals(choice.structuredContent.inboxes, []);
  assertStringIncludes(choice.text, "none of them can be used right now");
  assert(!choice.text.includes("inbox_id:"));

  const only = allInboxesBrokenChoice([{ ...repro[0], status: "error" }], reconnectUrl);
  assertEquals(only.structuredContent.inboxes, []);
  assertEquals((only.structuredContent.needs_reconnect as unknown[]).length, 1);
  assert(!only.text.includes("No mailbox is connected"));
  assertStringIncludes(only.text, `${APP}/dashboard/inboxes`);
});

Deno.test("inbox_list hint tells the model not to offer the inbox, with the link", () => {
  const hint = inboxHealthHint("reconnect_required", `${APP}/dashboard/inboxes`);
  assertStringIncludes(hint, "Do not offer it as a choice");
  assertStringIncludes(hint, `${APP}/dashboard/inboxes`);
  assertStringIncludes(inboxHealthHint("unavailable", "x"), "reconnecting will not help");
});

Deno.test("inboxHealthWrite: mark on a password-mailbox auth failure, clear on a later success", () => {
  const base = { rowHadMarker: false };
  assertEquals(inboxHealthWrite({ ...base, logStatus: "error", logErrorCode: "auth_failed", provider: "imap" }), "mark");
  assertEquals(inboxHealthWrite({ ...base, logStatus: "error", logErrorCode: "auth_failed", provider: "fastmail" }), "mark");
  // Gmail and Outlook move their own row to 'error'.
  assertEquals(inboxHealthWrite({ ...base, logStatus: "error", logErrorCode: "auth_failed", provider: "gmail" }), null);
  assertEquals(inboxHealthWrite({ ...base, logStatus: "error", logErrorCode: "auth_failed", provider: undefined }), null);
  assertEquals(inboxHealthWrite({ rowHadMarker: true, logStatus: "success", logErrorCode: null, provider: "imap" }), "clear");
  // The hot path: a success on an unmarked row, or an unrelated error, writes nothing.
  assertEquals(inboxHealthWrite({ ...base, logStatus: "success", logErrorCode: null, provider: "imap" }), null);
  assertEquals(inboxHealthWrite({ rowHadMarker: true, logStatus: "error", logErrorCode: "provider_error", provider: "imap" }), null);
});
