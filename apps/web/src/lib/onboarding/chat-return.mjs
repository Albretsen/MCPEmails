/**
 * Browser half of the chat connect link (`from=chat`). The server verifies the
 * link (chat-connect-link.ts) and hands the page `{ client }`; this keeps it
 * for the length of the connect, across the Microsoft sign-in round trip,
 * which comes back to /dashboard?connected=outlook with none of the link's
 * parameters. sessionStorage, two hours, read once.
 *
 * Client-safe: no imports.
 */

export const CHAT_RETURN_KEY = 'mcpe-chat-return';
export const CHAT_RETURN_TTL_MS = 2 * 60 * 60 * 1000;

const LINK_PARAMS = ['from', 'client', 'exp', 'sig'];

function storage(store) {
  if (store) return store;
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Remember a verified chat return. */
export function rememberChatReturn(chatReturn, { store = null, now = Date.now() } = {}) {
  const s = storage(store);
  if (!s || !chatReturn) return;
  try {
    s.setItem(CHAT_RETURN_KEY, JSON.stringify({ client: chatReturn.client ?? null, until: now + CHAT_RETURN_TTL_MS }));
  } catch {
    // Private mode: the dialog is a nicety.
  }
}

/** The remembered chat return, removed as it is read; null when absent or stale. */
export function takeChatReturn({ store = null, now = Date.now() } = {}) {
  const s = storage(store);
  if (!s) return null;
  try {
    const raw = s.getItem(CHAT_RETURN_KEY);
    if (!raw) return null;
    s.removeItem(CHAT_RETURN_KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.until !== 'number' || parsed.until <= now) return null;
    return { client: typeof parsed.client === 'string' ? parsed.client : null };
  } catch {
    return null;
  }
}

/** The "Connected. Go back to <client>" page for a chip id (or none). */
export function backToChatPath(client) {
  return typeof client === 'string' && /^[a-z_]{1,20}$/.test(client)
    ? `/onboarding/back-to-chat?client=${client}`
    : '/onboarding/back-to-chat';
}

/** `href` without the chat link's own parameters (the provider hint is stripped elsewhere). */
export function withoutChatLinkParams(href) {
  const url = new URL(href);
  if (url.searchParams.get('from') !== 'chat') return href;
  for (const key of LINK_PARAMS) url.searchParams.delete(key);
  return url.toString();
}
