/**
 * The AI-app choice in the /onboarding flow (owner feedback F1).
 *
 * There is never a "pick your AI" screen. Every step shows a chip,
 * "Using Claude · Change", and the choice is INFERRED, in this order
 * (inferOnboardingClient):
 *
 *   1. `?client=` on the URL (carried through signup by intent-carry.mjs)
 *   2. the choice already stored on the workspace (`workspaces.onboarding_client`,
 *      written by the chip, by /authorize for a connector-first user, or by the
 *      MCP server on the first tool call)
 *   3. the OAuth client a connector-first user arrived through (the caller
 *      passes it; /authorize stores it as (2) as well)
 *   4. where the signup came from (`workspaces.acquisition_source` /
 *      `acquisition_referrer`: claude.ai, chatgpt.com, a connector install)
 *   5. Claude
 *
 * Client-safe: no imports, no server code. The ids are the values the
 * `workspaces_onboarding_client_check` constraint and the product funnel
 * category CHECK accept (migration 20261026152301 added `claude_code`).
 */

/** The chip's first row, in display order. */
export const PRIMARY_CHIP_CLIENTS = Object.freeze(['claude', 'chatgpt', 'claude_code', 'cursor', 'vscode']);

/** Behind "More". Every other client the dashboard guide knows. */
export const MORE_CHIP_CLIENTS = Object.freeze([
  'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'raycast', 'warp', 'curl',
]);

export const CHIP_CLIENTS = Object.freeze([...PRIMARY_CHIP_CLIENTS, ...MORE_CHIP_CLIENTS]);

/** The default when nothing says otherwise. */
export const DEFAULT_CHIP_CLIENT = 'claude';

/**
 * Display names. Product names, so they are not translated (the words around
 * them, "Using", "Change", "More", live in messages/<locale>/onboarding.json).
 */
export const CHIP_CLIENT_LABELS = Object.freeze({
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
  cline: 'Cline',
  windsurf: 'Windsurf',
  gemini: 'Gemini CLI',
  zed: 'Zed',
  jetbrains: 'JetBrains',
  raycast: 'Raycast',
  warp: 'Warp',
  curl: 'API / curl',
});

const CHIP_SET = new Set(CHIP_CLIENTS);

/** The id when it is one the chip offers, else null. Never throws. */
export function normalizeChipClient(value) {
  return typeof value === 'string' && CHIP_SET.has(value) ? value : null;
}

/** "Claude", "VS Code", ... for a chip id; the default's label for anything else. */
export function chipClientLabel(id) {
  return CHIP_CLIENT_LABELS[normalizeChipClient(id) ?? DEFAULT_CHIP_CLIENT];
}

/**
 * The chip id for an `acquisition_source` / `acquisition_referrer` value
 * (the closed list in 20261022180000_acquisition_connector_sources.sql).
 */
export function chipClientFromAcquisition(value) {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'claude':
    case 'claude_directory':
    case 'connector_claude':
      return 'claude';
    case 'chatgpt':
    case 'chatgpt_directory':
    case 'connector_chatgpt':
      return 'chatgpt';
    case 'cursor':
    case 'cursor_directory':
    case 'connector_cursor':
      return 'cursor';
    case 'connector_vscode':
    case 'copilot':
      return 'vscode';
    case 'gemini':
      return 'gemini';
    default:
      return null;
  }
}

/**
 * The chip id for a host, from a referrer URL or an OAuth redirect_uri.
 * Accepts a full URL or a bare host. Unknown or malformed input is null.
 */
export function chipClientFromUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  let host = '';
  let protocol = '';
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    host = url.hostname.toLowerCase();
    protocol = url.protocol;
  } catch {
    return null;
  }
  // Desktop and IDE clients redirect to their own URL schemes.
  if (protocol === 'cursor:') return 'cursor';
  if (protocol === 'vscode:' || protocol === 'vscode-insiders:') return 'vscode';
  const is = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (is('claude.ai') || is('claude.com') || is('anthropic.com')) return 'claude';
  if (is('chatgpt.com') || is('openai.com')) return 'chatgpt';
  if (is('cursor.com') || is('cursor.sh')) return 'cursor';
  if (is('windsurf.com') || is('codeium.com')) return 'windsurf';
  if (is('raycast.com')) return 'raycast';
  if (is('warp.dev')) return 'warp';
  if (is('zed.dev')) return 'zed';
  return null;
}

/**
 * The chip id for an MCP `initialize` clientInfo.name, as stored in
 * `mcp_client_capabilities.client_name` ("claude-ai", "Claude Code",
 * "openai-mcp", "Visual Studio Code", "cursor-vscode", ...). Null when it names
 * nothing we know. Order matters: "claude-code" before "claude", "cursor"
 * before "vscode".
 */
export function chipClientFromHandshakeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.toLowerCase();
  if (n.includes('claude-code') || n.includes('claude code') || n.includes('claude_code')) return 'claude_code';
  if (n.includes('claude') || n.includes('anthropic')) return 'claude';
  if (n.includes('openai') || n.includes('chatgpt')) return 'chatgpt';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('windsurf') || n.includes('codeium')) return 'windsurf';
  if (n.includes('cline')) return 'cline';
  if (n.includes('visual studio code') || n.includes('vscode') || n.includes('copilot')) return 'vscode';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('zed')) return 'zed';
  if (n.includes('jetbrains') || n.includes('intellij')) return 'jetbrains';
  if (n.includes('raycast')) return 'raycast';
  if (n.includes('warp')) return 'warp';
  return null;
}

/**
 * Pick the chip's starting client. Every input is optional and untrusted.
 *
 * @param {{
 *   param?: unknown,              // ?client= on the /onboarding URL
 *   stored?: unknown,             // workspaces.onboarding_client
 *   oauthRedirectUri?: unknown,   // a connector-first user's OAuth redirect_uri
 *   acquisitionSource?: unknown,  // workspaces.acquisition_source
 *   acquisitionReferrer?: unknown,// workspaces.acquisition_referrer
 *   referrer?: unknown,           // document.referrer / a raw referrer URL
 * }} input
 * @returns {{ client: string, source: 'param'|'stored'|'oauth'|'acquisition'|'referrer'|'default' }}
 */
export function inferOnboardingClient(input = {}) {
  const param = normalizeChipClient(input.param);
  if (param) return { client: param, source: 'param' };
  const stored = normalizeChipClient(input.stored);
  if (stored) return { client: stored, source: 'stored' };
  const oauth = chipClientFromUrl(input.oauthRedirectUri);
  if (oauth) return { client: oauth, source: 'oauth' };
  const acquisition = chipClientFromAcquisition(input.acquisitionSource) ?? chipClientFromAcquisition(input.acquisitionReferrer);
  if (acquisition) return { client: acquisition, source: 'acquisition' };
  const referrer = chipClientFromUrl(input.referrer);
  if (referrer) return { client: referrer, source: 'referrer' };
  return { client: DEFAULT_CHIP_CLIENT, source: 'default' };
}
