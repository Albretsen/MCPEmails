import { assertEquals } from "jsr:@std/assert@1";
import { clientLabel, firstUseClientLabel, onboardingClientFor, openAiClientFamily } from "./client-label.ts";

Deno.test("clientLabel names ChatGPT's openai-mcp User-Agent", () => {
  assertEquals(clientLabel("openai-mcp/1.0.0"), "chatgpt");
  assertEquals(clientLabel("Mozilla/5.0 ChatGPT-User/1.0"), "chatgpt");
  assertEquals(clientLabel("codex_cli_rs/0.40.0"), "codex");
  assertEquals(clientLabel("openai-mcp (Codex)"), "codex");
  assertEquals(clientLabel("Claude-User"), "claude");
  assertEquals(clientLabel(null), "unknown");
  assertEquals(clientLabel("python-httpx/0.27"), "unknown");
});

Deno.test("openAiClientFamily reads every OpenAI handshake name seen in production", () => {
  assertEquals(openAiClientFamily("openai-mcp", null), "chatgpt");
  assertEquals(openAiClientFamily("openai-mcp (ChatGPT)", null), "chatgpt");
  assertEquals(openAiClientFamily("openai-mcp (Codex)", null), "codex");
  assertEquals(openAiClientFamily("Codex", null), "codex");
  assertEquals(openAiClientFamily("codex-config-check", null), "codex");
});

Deno.test("codex-mcp-client is settled by the key name", () => {
  assertEquals(openAiClientFamily("codex-mcp-client", "OAuth: ChatGPT"), "chatgpt");
  assertEquals(openAiClientFamily("codex-mcp-client", "OAuth: chatgpt.com (2)"), "chatgpt");
  assertEquals(openAiClientFamily("codex-mcp-client", "OAuth: Codex"), "codex");
  assertEquals(openAiClientFamily("codex-mcp-client", "My laptop key"), "codex");
  assertEquals(openAiClientFamily("codex-mcp-client", null), "codex");
});

Deno.test("an OpenAI OAuth key name alone names the client", () => {
  assertEquals(openAiClientFamily(null, "OAuth: ChatGPT"), "chatgpt");
  assertEquals(openAiClientFamily("unknown", "OAuth: OpenAI (3)"), "chatgpt");
  assertEquals(openAiClientFamily(null, "OAuth: Codex (2)"), "codex");
});

Deno.test("non-OpenAI clients are not OpenAI", () => {
  assertEquals(openAiClientFamily("claude-ai", "OAuth: Claude"), null);
  assertEquals(openAiClientFamily("cursor-vscode", "Default key"), null);
  assertEquals(openAiClientFamily(null, null), null);
  assertEquals(openAiClientFamily("my-openai-wrapper", null), null);
});

Deno.test("firstUseClientLabel prefers the handshake for OpenAI, the User-Agent otherwise", () => {
  assertEquals(firstUseClientLabel("python-httpx/0.27", "openai-mcp", "OAuth: ChatGPT"), "chatgpt");
  assertEquals(firstUseClientLabel(null, "codex-mcp-client", "API key"), "codex");
  assertEquals(firstUseClientLabel("Claude-User", "claude-ai", "OAuth: Claude"), "claude");
  assertEquals(firstUseClientLabel(null, "cursor-vscode", null), "cursor");
  assertEquals(firstUseClientLabel(null, null, null), "unknown");
  assertEquals(firstUseClientLabel(null, "Visual Studio Code", null), "unknown");
});

Deno.test("onboarding_client stays inside its CHECK list", () => {
  assertEquals(onboardingClientFor("codex"), "chatgpt");
  assertEquals(onboardingClientFor("chatgpt"), "chatgpt");
  assertEquals(onboardingClientFor("unknown"), "unknown");
});
