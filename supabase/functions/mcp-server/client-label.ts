/**
 * The coarse client label for a request, read from its User-Agent.
 *
 * Since 2026-10-20 `/api/mcp` reaches this function as a Vercel rewrite, so the
 * User-Agent and X-Forwarded-For seen here are the real client's, not the old
 * proxy's (`node` and a Vercel address). Neither is stored or logged: the raw
 * header is read in memory and only this fixed label ("claude", "cursor",
 * "unknown", ...) may leave the request, in the first-use funnel marker and in
 * log lines that need to tell clients apart. The client IP is not read at all.
 */
const CLIENT_NEEDLES: ReadonlyArray<readonly [string, string]> = [
  ["claude", "claude"],
  // Codex before the generic OpenAI needle: Codex can present as
  // `openai-mcp (Codex)`, and that is Codex, not ChatGPT.
  ["codex", "codex"],
  ["chatgpt", "chatgpt"],
  // ChatGPT's connector User-Agent is `openai-mcp/<version>`, with no
  // "chatgpt" in it. Until 2026-11-16 that labelled every ChatGPT workspace
  // "unknown".
  ["openai", "chatgpt"],
  ["cursor", "cursor"],
  ["vscode", "vscode"],
  ["cline", "cline"],
  ["windsurf", "windsurf"],
  ["gemini", "gemini"],
  ["zed", "zed"],
  ["jetbrains", "jetbrains"],
  ["raycast", "raycast"],
  ["warp", "warp"],
  ["curl", "curl"],
];

export function clientLabel(userAgent: string | null): string {
  const ua = (userAgent ?? "").toLowerCase();
  for (const [needle, client] of CLIENT_NEEDLES) if (ua.includes(needle)) return client;
  return "unknown";
}

/**
 * Which OpenAI client this is, from what `initialize` recorded
 * (`mcp_client_capabilities.client_name`) and the key's own name, or null when
 * neither names an OpenAI client. Mirrored in SQL by
 * `public.openai_client_family(text, text)`; keep the two in step.
 *
 * Names seen in production: `openai-mcp`, `openai-mcp (ChatGPT)`,
 * `openai-mcp (Codex)`, `Codex`, `codex-config-check` and `codex-mcp-client`.
 * The last is ambiguous: ChatGPT connectors present it too. ChatGPT connects
 * through OAuth, and our token endpoint names the key after the client's
 * registration (`OAuth: ChatGPT`, `OAuth: chatgpt.com`, `OAuth: Codex`, see
 * isOpenAiOAuthKeyName), so the key name settles it: an OAuth key not
 * registered as Codex is ChatGPT, and a pasted API key is Codex.
 */
export function openAiClientFamily(
  clientName: string | null | undefined,
  keyName: string | null | undefined,
): "chatgpt" | "codex" | null {
  const name = (clientName ?? "").trim().toLowerCase();
  const key = (keyName ?? "").trim();
  const keyIsOAuth = /^OAuth: /i.test(key);
  const keyIsCodex = /^OAuth: codex( \(\d+\))?$/i.test(key);
  const keyIsChatGpt = /^OAuth: (chatgpt(\.com)?|openai)( \(\d+\))?$/i.test(key);
  if (name.startsWith("openai-mcp")) return name.includes("codex") ? "codex" : "chatgpt";
  if (name.startsWith("codex-mcp-client")) {
    if (keyIsCodex) return "codex";
    return keyIsOAuth ? "chatgpt" : "codex";
  }
  if (name.startsWith("codex")) return "codex";
  if (keyIsCodex) return "codex";
  if (keyIsChatGpt) return "chatgpt";
  return null;
}

/**
 * The label markFirstProductUse stores in `analytics_first_tool_client`. For
 * OpenAI clients the handshake name and key name win, since their User-Agent
 * says little. Everything else keeps the User-Agent label it always had and
 * falls back to the handshake name only when the User-Agent names nothing.
 */
export function firstUseClientLabel(
  userAgent: string | null,
  clientName: string | null | undefined,
  keyName: string | null | undefined,
): string {
  const openAi = openAiClientFamily(clientName, keyName);
  if (openAi) return openAi;
  const fromUa = clientLabel(userAgent);
  if (fromUa !== "unknown") return fromUa;
  return clientName ? clientLabel(clientName) : "unknown";
}

/**
 * `workspaces.onboarding_client` takes only the chip ids allowed by
 * workspaces_onboarding_client_check, and there is no Codex chip. A Codex
 * first use records the OpenAI chip, `chatgpt`.
 */
export function onboardingClientFor(label: string): string {
  return label === "codex" ? "chatgpt" : label;
}
