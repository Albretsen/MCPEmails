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
  ["chatgpt", "chatgpt"],
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
