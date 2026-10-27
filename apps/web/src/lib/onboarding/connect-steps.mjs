/**
 * Pure logic behind the /onboarding steps after the inbox (plan A6, A8, A9;
 * WP-F): which install path a client gets, which prompt text, where the live
 * ladder stands, which timed help to show, and the plain-words reading of the
 * last failed call. Client-safe: no imports beyond other pure modules, no
 * strings (the panels turn the keys returned here into copy from
 * messages/<locale>/onboarding.json).
 *
 * Prompt kit: Documents/plans/onboarding-research-20261026/05-aha-moment-first-prompts.md.
 * Wait timings: .../11-live-first-call-detection.md (R2, R3).
 */
import { deviceClass } from '../acquisition-device.mjs';

// ── Vocabulary shared with the server (src/lib/onboarding/assist.ts) ────────

/** Timed help tiers. Funnel category = `help_<tier>`. */
export const HELP_TIERS = Object.freeze(['no_handshake', 'no_call', 'reconnect']);
/** Prompts a user can copy. Funnel category = `prompt_<kind>`. */
export const PROMPT_KINDS = Object.freeze(['reply_radar', 'draft_replies', 'morning_brief']);
/** Links we email. Funnel category = `link_<kind>`. */
export const LINK_KINDS = Object.freeze(['add_to_ai', 'help_steps']);

// ── Timings ─────────────────────────────────────────────────────────────────

/** Credential (or nothing) and no handshake after this long: restart steps. */
export const NO_HANDSHAKE_HELP_MS = 90 * 1000;
/** Handshake seen and no call after this long: switch it on in the chat. */
export const NO_CALL_HELP_MS = 60 * 1000;
/** Nothing working after this long: reconnect, docs, email me the steps. */
export const RECONNECT_HELP_MS = 10 * 60 * 1000;

// ── Clients ─────────────────────────────────────────────────────────────────

/** Clients that take a pasted API key instead of the OAuth browser flow (clients.mjs `auth: 'apikey'`). */
const API_KEY_CLIENTS = new Set(['cline', 'jetbrains', 'curl']);
/** Coding agents and editors: prompts start "Use the MCPEmails tools to". */
const CODE_CLIENTS = new Set(['claude_code', 'cursor', 'vscode', 'cline', 'windsurf', 'gemini', 'zed', 'jetbrains', 'warp']);

export function usesApiKey(client) {
  return API_KEY_CLIENTS.has(client);
}

/**
 * 'chatgpt' | 'chat' | 'code' | 'api'. Decides prompt wording and help text.
 * Raycast is a launcher with a chat, so it reads like Claude.
 */
export function clientKind(client) {
  if (client === 'chatgpt') return 'chatgpt';
  if (client === 'curl') return 'api';
  if (CODE_CLIENTS.has(client)) return 'code';
  return 'chat';
}

/**
 * Which help text family a client's "not connected yet" tip uses:
 * 'claude' | 'chatgpt' | 'editor' | 'cli' | 'api'.
 */
export function restartKind(client) {
  if (client === 'claude') return 'claude';
  if (client === 'chatgpt') return 'chatgpt';
  if (client === 'curl') return 'api';
  if (['cursor', 'vscode', 'windsurf', 'zed', 'cline', 'jetbrains'].includes(client)) return 'editor';
  return 'cli';
}

/** /docs/<slug> for a chip id. */
const DOCS_SLUGS = Object.freeze({ claude_code: 'claude-code', gemini: 'gemini-cli' });
export function docsPath(client) {
  return `/docs/${DOCS_SLUGS[client] ?? client}`;
}

/**
 * The scopes the onboarding creates an API key with: the Standard preset
 * (read, drafts, send, contacts), the same default the consent screen offers
 * (owner decision F3). Kept in step with ACCESS_PRESETS 'standard' in
 * src/lib/oauth/consent-presets.ts by connect-steps.test.mjs.
 */
export const ONBOARDING_KEY_SCOPES = Object.freeze(['read:email', 'search:email', 'send:email', 'manage:drafts', 'manage:contacts']);

/**
 * Config files for the OAuth clients with no install link or command
 * (field names as in src/lib/clients/clients.mjs: Windsurf wants serverUrl,
 * Zed context_servers). Null for clients set up in a form instead.
 */
export function configSnippet(client, url) {
  if (client === 'windsurf') {
    return { file: '~/.codeium/windsurf/mcp_config.json', text: JSON.stringify({ mcpServers: { mcpemails: { serverUrl: url } } }, null, 2) };
  }
  if (client === 'zed') {
    return { file: 'settings.json', text: JSON.stringify({ context_servers: { mcpemails: { url } } }, null, 2) };
  }
  return null;
}

/** True on a phone (not a tablet, not a desktop). */
export function isPhone(userAgent) {
  return deviceClass(userAgent) === 'mobile';
}

// ── Prompts ─────────────────────────────────────────────────────────────────

/**
 * Message keys (namespace onboarding) for the prompts a client gets.
 *
 *   replyRadar     the first prompt; everyone except the raw API
 *   draftReplies   the second prompt; never for coding clients (report 05:
 *                  keep them to prompts 1 and 4); read-only keys get the
 *                  "write them here in the chat" variant, never a draft
 *   morningBrief   tomorrow's ritual
 *
 * ChatGPT and Claude share the "Using MCPEmails, ..." wording; coding clients
 * get "Use the MCPEmails tools to ...". null means "do not show".
 */
export function promptKeys(client, { canDraft = true } = {}) {
  const kind = clientKind(client);
  if (kind === 'api') return { replyRadar: null, draftReplies: null, morningBrief: null };
  const code = kind === 'code';
  return {
    replyRadar: code ? 'prompts.replyRadar.code' : 'prompts.replyRadar.chat',
    draftReplies: code ? null : canDraft ? 'prompts.draftReplies.drafts' : 'prompts.draftReplies.readOnly',
    morningBrief: code ? 'prompts.morningBrief.code' : 'prompts.morningBrief.chat',
  };
}

/** Can the newest key save drafts? Unknown scopes (null) count as yes. */
export function canDraftWith(scopes) {
  if (!Array.isArray(scopes)) return true;
  return scopes.includes('manage:drafts');
}

/** The first real call for an API caller: list the last 2 days. */
export function curlFirstCall(mcpUrl, key) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'email_read', arguments: { action: 'list', since: '2 days ago' } },
  });
  return `curl -X POST ${mcpUrl} \\\n  -H "Authorization: Bearer ${key || 'YOUR_API_KEY'}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '${body}'`;
}

/** Where "Open <client>" goes. Claude: a new chat (no prefill, see WaitPanel). */
export function openClientHref(client) {
  if (client === 'claude') return 'https://claude.ai/new';
  if (client === 'chatgpt') return 'https://chatgpt.com/';
  return null;
}

// ── The ladder ──────────────────────────────────────────────────────────────

function ms(ts) {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * When the AI app was first seen talking to us since reset, on the ms clock,
 * or null. Several signals count, because claude.ai reuses its MCP session
 * across chats and often sends no new `initialize` (WP-Z M1):
 *
 *   handshake.at                 an MCP `initialize` since reset
 *   anyCall.at                   any successful tool call since reset
 *   firstCall.at, lastFailure.at a call that reached MCPEmails, even one
 *                                that failed
 *   credential.latestAt          a connector grant since reset (OAuth clients
 *                                only: an API-key client creates its key on
 *                                the add step itself, so it proves nothing)
 *
 * The earliest one wins: the app was connected from that moment on.
 */
export function connectedAtMs(status, { client } = {}) {
  if (!status) return null;
  const times = [ms(status.handshake?.at), ms(status.anyCall?.at), ms(status.firstCall?.at), ms(status.lastFailure?.at)];
  if (status.credential?.sinceReset && !usesApiKey(client)) times.push(ms(status.credential?.latestAt));
  const seen = times.filter((t) => t !== null);
  if (seen.length) return Math.min(...seen);
  // A grant since reset with an unreadable timestamp still counts.
  if (status.credential?.sinceReset && !usesApiKey(client)) return 0;
  return null;
}

/**
 * Where the four-rung ladder stands:
 *   0  Waiting for <client>       nothing yet
 *   1  <client> connected         any connected signal (connectedAtMs)
 *   2  Ask it something           (the current rung once connected)
 *   3  It works                   a successful real-inbox call
 * Returns { rung, connected, works }. `rung` is the CURRENT rung.
 */
export function ladderState(status, { client } = {}) {
  const works = Boolean(status?.firstCall?.at);
  const connected = works || connectedAtMs(status, { client }) !== null;
  return { rung: works ? 3 : connected ? 2 : 0, connected, works };
}

/**
 * Which timed help is open now. All times in ms on ONE clock: the panel
 * passes the server's clock (status.serverTime plus time since it was read)
 * as `nowMs`, and `waitStartedAtMs` on the same clock.
 *
 *   not connected (connectedAtMs), 90 s after the wait
 *   started                                            -> 'no_handshake'
 *   connected, no call of any kind, 60 s after the
 *   connection (or after the wait started, whichever
 *   is later), and no blocking failure on show        -> 'no_call'
 *   calls arriving but none on a real inbox yet         -> neither
 *   10 min after the wait started, still no call       -> 'reconnect' too
 *
 * Returns the list of open tiers, in display order.
 */
export function helpTiers(status, { waitStartedAtMs, nowMs, client } = {}) {
  if (!status || status.firstCall?.at || !Number.isFinite(waitStartedAtMs) || !Number.isFinite(nowMs)) return [];
  const tiers = [];
  const connectedMs = connectedAtMs(status, { client });
  if (connectedMs === null) {
    if (nowMs - waitStartedAtMs >= NO_HANDSHAKE_HELP_MS) tiers.push('no_handshake');
  } else if (!status.anyCall?.at && !blockingFailure(status, waitStartedAtMs) && nowMs - Math.max(connectedMs, waitStartedAtMs) >= NO_CALL_HELP_MS) {
    tiers.push('no_call');
  }
  if (nowMs - waitStartedAtMs >= RECONNECT_HELP_MS) tiers.push('reconnect');
  return tiers;
}

/**
 * A failed call worth showing: newer than the wait start minus a minute
 * (so one from a test just before the page opened still counts) and not
 * followed by the first success.
 */
export function visibleFailure(status, waitStartedAtMs) {
  const failure = status?.lastFailure;
  if (!failure) return null;
  const at = ms(failure.at);
  if (at === null) return null;
  if (Number.isFinite(waitStartedAtMs) && at < waitStartedAtMs - 60 * 1000) return null;
  const first = ms(status.firstCall?.at);
  if (first !== null && first >= at) return null;
  return failure;
}

/**
 * Failed calls the user has to fix before the AI app can do anything: the
 * inbox password was rejected, the grant lacks the scope, or no inbox is
 * connected. Any other failure (bad arguments, a message that is not there,
 * a timeout, a limit) still proves the app reached MCPEmails: the status
 * counts it as working (firstCall.reached) and the dialog says nothing about
 * it, since the AI app retries or explains by itself.
 */
export const BLOCKING_FAILURE_CODES = Object.freeze(['auth_failed', 'imap_auth_failed', 'reauth_required', 'insufficient_scope', '-32004', 'no_inbox_connected']);

/** The visible failure (visibleFailure) when it is a blocking one, else null. */
export function blockingFailure(status, waitStartedAtMs) {
  const failure = visibleFailure(status, waitStartedAtMs);
  return failure && BLOCKING_FAILURE_CODES.includes(failure.code) ? failure : null;
}

/** Message key for a failed call's error code, in plain words. */
export function failureKey(code) {
  switch (code) {
    case 'auth_failed':
    case 'imap_auth_failed':
    case 'reauth_required':
      return 'failure.auth';
    case 'search_timeout':
    case 'timeout':
      return 'failure.timeout';
    case 'provider_error':
    case 'upstream_error':
    case 'inbox_unreachable':
    case 'inbox_unavailable':
      return 'failure.provider';
    case 'insufficient_scope':
    case '-32004':
      return 'failure.scope';
    case 'no_inbox_connected':
    case 'inbox_not_found':
      return 'failure.inbox';
    case '-32602':
    case 'invalid_params':
      return 'failure.params';
    default:
      return 'failure.generic';
  }
}

/**
 * Message key for the success line, from the first call's tool name. A call
 * that reached MCPEmails but failed (firstCall.reached) only proves the
 * connection.
 */
export function successKey(tool, { reached = false } = {}) {
  if (reached) return 'steps.it_works.success.connected';
  if (typeof tool !== 'string') return 'steps.it_works.success.generic';
  if (tool === 'draft' || tool.startsWith('draft_')) return 'steps.it_works.success.draft';
  if (tool === 'email_search' || tool === 'contact_search') return 'steps.it_works.success.search';
  if (tool.startsWith('email_read') || tool === 'email_list') return 'steps.it_works.success.read';
  const organize = ['email_organize', 'email_search_and_move', 'email_move', 'email_move_batch', 'email_archive', 'email_flag', 'folder_create', 'folder_rename'];
  if (organize.includes(tool)) return 'steps.it_works.success.organize';
  return 'steps.it_works.success.generic';
}

/**
 * Should the add-to-AI step move on by itself? Only on a signal that is NEW
 * since the step opened (so a reused workspace, or a user who came back to
 * set up a second app, is not skipped past the button). An API-key client
 * creates its own key on this step, so only a handshake counts for it.
 */
export function addToAiDone(status, { client, openedAtMs }) {
  if (!status) return false;
  const after = (ts) => {
    const t = ms(ts);
    return t !== null && (!Number.isFinite(openedAtMs) || t > openedAtMs);
  };
  if (after(status.handshake?.at)) return true;
  if (usesApiKey(client)) return false;
  return Boolean(status.credential?.sinceReset) && after(status.credential?.latestAt);
}
