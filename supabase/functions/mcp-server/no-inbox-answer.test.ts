import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildConnectUrl,
  chatClientFor,
  connectFixFor,
  enrichNoInboxResult,
  guessProviderFromEmail,
  noInboxMode,
  noInboxText,
  signConnectLink,
  type NoInboxContext,
} from "./no-inbox-answer.ts";

// The shared vector. apps/web/src/lib/onboarding/chat-connect-link.test.ts
// checks the SAME inputs give the SAME signature; change both or neither.
const VECTOR = {
  keyHex: "0123456789abcdef".repeat(4),
  workspaceId: "11111111-2222-3333-4444-555555555555",
  exp: 1893456000,
  provider: "gmail",
  client: "claude",
  sig: "h_1vy3iJ2iy_aRY5wTCBAm3eHgxZ_f3wBU1REzLbLZk",
};

Deno.test("signature matches the shared web vector", async () => {
  const sig = await signConnectLink(VECTOR.keyHex, VECTOR.workspaceId, VECTOR.exp, VECTOR.provider, VECTOR.client);
  assertEquals(sig, VECTOR.sig);
});

Deno.test("an unusable key signs nothing", async () => {
  assertEquals(await signConnectLink(undefined, VECTOR.workspaceId, 1, null, null), null);
  assertEquals(await signConnectLink("not-hex", VECTOR.workspaceId, 1, null, null), null);
});

Deno.test("provider guess from the account email domain", () => {
  assertEquals(guessProviderFromEmail("a@gmail.com"), "gmail");
  assertEquals(guessProviderFromEmail("a@GoogleMail.com"), "gmail");
  assertEquals(guessProviderFromEmail("a@hotmail.co.uk"), "outlook");
  assertEquals(guessProviderFromEmail("a@outlook.com"), "outlook");
  assertEquals(guessProviderFromEmail("a@yahoo.fr"), "yahoo");
  assertEquals(guessProviderFromEmail("a@me.com"), "icloud");
  assertEquals(guessProviderFromEmail("a@fastmail.com"), "fastmail");
  assertEquals(guessProviderFromEmail("a@company.no"), null);
  assertEquals(guessProviderFromEmail("a@outlook.example.com"), null);
  assertEquals(guessProviderFromEmail("a@live.example.org"), null);
  assertEquals(guessProviderFromEmail(null), null);
  assertEquals(guessProviderFromEmail("nonsense"), null);
});

Deno.test("client from user agent, then key name", () => {
  assertEquals(chatClientFor("Claude-User", null), "claude");
  assertEquals(chatClientFor("claude-code/2.0.1", null), "claude_code");
  assertEquals(chatClientFor("openai-mcp/1.0", null), "chatgpt");
  assertEquals(chatClientFor("node", "ChatGPT · Oct 2026"), "chatgpt");
  assertEquals(chatClientFor("Visual Studio Code", null), "vscode");
  assertEquals(chatClientFor(null, null), null);
});

Deno.test("connect URL is signed and carries the hints", async () => {
  const url = new URL(await buildConnectUrl({
    appUrl: "https://mcpemails.com",
    workspaceId: VECTOR.workspaceId,
    provider: "gmail",
    client: "claude",
    keyHex: VECTOR.keyHex,
    nowMs: (VECTOR.exp - 24 * 3600) * 1000,
  }));
  assertEquals(url.pathname, "/dashboard/inboxes");
  assertEquals(url.searchParams.get("from"), "chat");
  assertEquals(url.searchParams.get("provider"), "gmail");
  assertEquals(url.searchParams.get("client"), "claude");
  assertEquals(url.searchParams.get("exp"), String(VECTOR.exp));
  assertEquals(url.searchParams.get("sig"), VECTOR.sig);
});

Deno.test("connect URL without a key is unsigned, unknown client dropped", async () => {
  const url = new URL(await buildConnectUrl({
    appUrl: "https://mcpemails.com", workspaceId: VECTOR.workspaceId, provider: null, client: "evil<script>", keyHex: null, nowMs: 0,
  }));
  assertEquals(url.searchParams.get("sig"), null);
  assertEquals(url.searchParams.get("client"), null);
  assertEquals(url.searchParams.get("provider"), null);
});

Deno.test("text names the provider, never 'about a minute' for app-password providers, never a price", () => {
  for (const provider of ["gmail", "icloud", "yahoo"] as const) {
    const text = noInboxText({ mode: "list", provider, connectUrl: "https://x", fix: null });
    assert(!text.includes("about a minute"), provider);
    assertStringIncludes(text, "about 2 minutes");
    assert(!/\$|plan|price/i.test(text), provider);
  }
  const gmail = noInboxText({ mode: "list", provider: "gmail", connectUrl: "https://x", fix: null });
  assertStringIncludes(gmail, "Your account email is a Gmail address. Connecting Gmail takes an app password, about 2 minutes.");
  assertStringIncludes(gmail, "call inbox_list again");
  const err = noInboxText({ mode: "error", provider: null, connectUrl: "https://x", fix: null });
  assertStringIncludes(err, "Retry this tool");
});

Deno.test("fix for a Gmail app-password failure has three Gmail steps", () => {
  const fix = connectFixFor({ provider: "gmail", errorCategory: "auth_failed", authReason: "account_password_used" });
  assert(fix);
  assertEquals(fix.steps.length, 3);
  assertStringIncludes(fix.steps[1], "myaccount.google.com/apppasswords");
  assertEquals(connectFixFor(null), null);
  assertEquals(connectFixFor({ provider: "gmail", errorCategory: "plan_limit", authReason: null }), null);
  assertStringIncludes(connectFixFor({ provider: "outlook", errorCategory: "consent_required", authReason: null })!.reason, "administrator");
});

function ctx(overrides: Partial<NoInboxContext> = {}, email: string | null = "a@gmail.com", failure = null as null | { provider: string; errorCategory: string | null; authReason: string | null }): NoInboxContext {
  return {
    appUrl: "https://mcpemails.com",
    workspaceId: VECTOR.workspaceId,
    userAgent: "Claude-User",
    keyName: null,
    keyHex: VECTOR.keyHex,
    nowMs: Date.UTC(2026, 9, 26),
    deps: { accountEmail: () => Promise.resolve(email), recentFailure: () => Promise.resolve(failure) },
    ...overrides,
  };
}

Deno.test("enriches the empty inbox_list in place", async () => {
  const structured = { inboxes: [], setup_required: true, setup_url: "https://mcpemails.com/dashboard/inboxes", message: "old" };
  const response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured } };
  assertEquals(noInboxMode(response, null), "list");
  await enrichNoInboxResult(response, null, ctx({}, "a@gmail.com", { provider: "gmail", errorCategory: "auth_failed", authReason: "app_password_required" }));
  const result = response.result as Record<string, any>;
  assertStringIncludes(result.structuredContent.setup_url, "from=chat");
  assertStringIncludes(result.structuredContent.message, "Gmail address");
  assertStringIncludes(result.structuredContent.message, "1. Turn on 2-Step Verification");
  assertEquals(JSON.parse(result.content[0].text).setup_url, result.structuredContent.setup_url);
  assertEquals(result._meta["mcpemails/setup_required"], true);
  assertEquals(result._meta["mcpemails/connect_url"], result.structuredContent.setup_url);
  assertEquals(result._meta["mcpemails/provider_guess"], "gmail");
  assertEquals(result._meta["mcpemails/connect_failure"].reason, "app_password_required");
});

Deno.test("enriches no_inbox_connected and leaves everything else alone", async () => {
  const response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "old" }], isError: true } };
  await enrichNoInboxResult(response, "no_inbox_connected", ctx({}, "a@outlook.com"));
  const result = response.result as Record<string, any>;
  assertStringIncludes(result.content[0].text, "Microsoft sign-in");
  assertStringIncludes(result.content[0].text, "provider=outlook");

  const other = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "keep" }], isError: true } };
  await enrichNoInboxResult(other, "inbox_not_found", ctx());
  assertEquals(other.result.content[0].text, "keep");

  const listed = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }], structuredContent: { inboxes: [{}] } } };
  await enrichNoInboxResult(listed, null, ctx());
  assertEquals(listed.result.content[0].text, "{}");
});

Deno.test("a failing lookup still answers, with no provider named", async () => {
  const response = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "old" }], isError: true } };
  await enrichNoInboxResult(response, "no_inbox_connected", ctx({
    deps: { accountEmail: () => Promise.reject(new Error("db down")), recentFailure: () => Promise.reject(new Error("db down")) },
  }));
  const text = (response.result as Record<string, any>).content[0].text as string;
  assertStringIncludes(text, "No mailbox is connected");
  assert(!text.includes("Your account email"));
});
