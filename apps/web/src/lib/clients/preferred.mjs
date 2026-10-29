/**
 * The visitor's AI assistant, for the client-first website (owner feedback F5).
 *
 * A visitor who arrives from Claude, ChatGPT, Cursor, Perplexity or Gemini sees
 * that assistant first in a few places on the marketing site: the home page
 * client marquee and hero diagram, the setup-guide links, the /docs client
 * tabs and the /docs/clients hub. Nothing else changes. In particular no
 * <title>, meta description, generateMetadata output or JSON-LD reads this:
 * a crawler arrives with no AI signal and must get exactly what everyone else
 * gets (snippet CTR test, and cloaking safety).
 *
 * WHERE THE SIGNAL COMES FROM. proxy.ts reads the request: utm_source first
 * (ChatGPT stamps utm_source=chatgpt.com on every link it surfaces), then
 * `?ref=` / `?source=`, then the Referer host. Matching reuses
 * src/lib/acquisition-context.mjs, so "what counts as ChatGPT" is decided in
 * one place. Only AI categories count; a direct or Google visit never replaces
 * an earlier AI signal. The proxy hands the slug to this render in a request
 * header and remembers it in a 30-day cookie for the next page views.
 *
 * WHAT THIS IS NOT. Not attribution (that is acquisition-context.mjs and is
 * written to the workspace), and not the onboarding chip's choice, though the
 * signup links carry it there as `?client=` (intent-carry.mjs).
 *
 * Plain .mjs with one pure import: the proxy, client components and node:test
 * all load it.
 */
import { sourceFromHost, sourceFromRefParams, sourceFromUtm } from '../acquisition-context.mjs';
import { normalizeChipClient } from '../onboarding/clients.mjs';

/** The assistants this can put first. Each is a /docs/<slug> client page. */
export const AI_CLIENTS = Object.freeze(['claude', 'chatgpt', 'cursor', 'perplexity', 'gemini']);

/** Request header the proxy sets for the current render. */
export const AI_CLIENT_HEADER = 'x-ai-client';

/** The cookie that remembers it for later page views. */
export const AI_CLIENT_COOKIE = 'mx_ai_client';

export const AI_CLIENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Product names, not translated. */
export const AI_CLIENT_NAMES = Object.freeze({
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
});

const AI_SET = new Set(AI_CLIENTS);

/** The slug when it is one of AI_CLIENTS, else null. Never throws. */
export function normalizeAiClient(value) {
  return typeof value === 'string' && AI_SET.has(value) ? value : null;
}

/**
 * The AI client for an acquisition category (sourceFromUtm, sourceFromHost,
 * sourceFromRefParams output). Null for everything that is not an assistant,
 * including `direct`, search engines and directories that are not an
 * assistant's own.
 */
export function aiClientFromSignal(category) {
  switch (category) {
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
    case 'perplexity':
      return 'perplexity';
    case 'gemini':
      return 'gemini';
    default:
      return null;
  }
}

/**
 * The AI client a request names, or null.
 *
 * @param {URL} url the requested URL
 * @param {string | null | undefined} referer the Referer header
 */
export function aiClientFromRequest(url, referer) {
  const fromUtm = aiClientFromSignal(sourceFromUtm(url.searchParams.get('utm_source')));
  if (fromUtm) return fromUtm;
  const fromRef = aiClientFromSignal(sourceFromRefParams(url.searchParams));
  if (fromRef) return fromRef;
  if (typeof referer === 'string' && referer !== '') {
    try {
      const ref = new URL(referer);
      if (ref.origin !== url.origin) return aiClientFromSignal(sourceFromHost(ref.hostname));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `list` with every item whose key equals `preferred` moved to the front,
 * everything else in its original order. Returns a new array; with no
 * preferred client (or no match) it is a copy of `list` in the same order.
 *
 * @template T
 * @param {readonly T[]} list
 * @param {string | null | undefined} preferred
 * @param {(item: T) => unknown} [key]
 * @returns {T[]}
 */
export function orderClients(list, preferred, key = (item) => item) {
  if (!preferred) return [...list];
  const first = [];
  const rest = [];
  for (const item of list) (key(item) === preferred ? first : rest).push(item);
  return [...first, ...rest];
}

/**
 * The onboarding chip id to put on a signup link as `?client=`, or null.
 * Accepts an AI slug or a /docs/<client> slug (`claude-code`, `gemini-cli`).
 */
export function signupClientParam(slug) {
  if (typeof slug !== 'string') return null;
  if (slug === 'gemini-cli') return 'gemini';
  return normalizeChipClient(slug.replace(/-/g, '_'));
}

/** The cookie as a raw Set-Cookie value (see the subject cookie in proxy.ts for why raw). */
export function serializeAiClientCookie(slug, isSecure) {
  const clean = normalizeAiClient(slug);
  if (!clean) return null;
  const parts = [
    `${AI_CLIENT_COOKIE}=${clean}`,
    'Path=/',
    `Max-Age=${AI_CLIENT_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecure) parts.push('Secure');
  return parts.join('; ');
}
