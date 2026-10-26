'use client';

/**
 * Browser calls for the WP-F steps (add to AI, prompt + wait, It works).
 *
 *   assistEvent(event, fields)   POST /api/onboarding/assist {action: 'event'}
 *                                fire and forget, never throws
 *   emailMe(kind, client, locale)       the setup link or the help steps, to
 *                                the signed-in user's own address -> {ok, email}
 *   morningBriefOptIn(client, locale)   "Email me this tomorrow at 8" -> {ok, email}
 *   createOnboardingKey(clientLabel, scopes)  POST /api/api-keys -> {ok, rawKey}
 *                                | {ok: false, reason: 'limit'|'failed'}
 *
 * Memory (module scope, lost on reload, never written anywhere):
 *   revealedKeys   the raw key created for a client on this page load, so a
 *                  re-render or the next step can show it without minting
 *                  another one
 *   waitStartedAt  when the prompt/wait screen first opened on this load, so
 *                  the timed help survives the first_prompt -> wait remount
 */

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { ok: res.ok, status: res.status, json };
}

export function assistEvent(event, fields = {}) {
  try {
    fetch('/api/onboarding/assist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ action: 'event', event, ...fields }),
    }).catch(() => {});
  } catch {
    // Analytics never breaks the flow.
  }
}

export async function emailMe(kind, client, locale) {
  try {
    const res = await post('/api/onboarding/assist', { action: 'email_link', kind, client, locale });
    return { ok: res.ok, email: res.json?.email ?? null };
  } catch {
    return { ok: false, email: null };
  }
}

export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function morningBriefOptIn(client, locale) {
  try {
    const res = await post('/api/onboarding/assist', { action: 'morning_brief', client, locale, timeZone: browserTimeZone() });
    return { ok: res.ok, email: res.json?.email ?? null };
  } catch {
    return { ok: false, email: null };
  }
}

export const memory = { revealedKeys: new Map(), pendingKeys: new Map(), waitStartedAt: null };

/**
 * The server's clock: the newest status.serverTime plus the local time that
 * passed since it arrived. Called from effects only.
 */
const clockAnchor = { server: null, local: 0, seen: null };
export function noteServerTime(serverTime) {
  if (typeof serverTime !== 'string' || serverTime === clockAnchor.seen) return;
  const parsed = Date.parse(serverTime);
  if (!Number.isFinite(parsed)) return;
  clockAnchor.seen = serverTime;
  clockAnchor.server = parsed;
  clockAnchor.local = Date.now();
}
export function serverNow() {
  return clockAnchor.server === null ? Date.now() : clockAnchor.server + (Date.now() - clockAnchor.local);
}

/**
 * Create the API key for an API-key client, once per client per page load.
 * The name must be unique in the workspace, so a taken name gets the time.
 */
export function createOnboardingKey(client, clientLabel, scopes) {
  if (memory.revealedKeys.has(client)) return Promise.resolve({ ok: true, rawKey: memory.revealedKeys.get(client) });
  if (memory.pendingKeys.has(client)) return memory.pendingKeys.get(client);
  const attempt = async () => {
    const base = `MCPEmails setup (${clientLabel})`;
    for (const name of [base, `${base} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`]) {
      let res;
      try {
        res = await post('/api/api-keys', { name, scopes });
      } catch {
        return { ok: false, reason: 'failed' };
      }
      if (res.ok && res.json?.rawKey) {
        memory.revealedKeys.set(client, res.json.rawKey);
        return { ok: true, rawKey: res.json.rawKey };
      }
      if (res.status === 409) continue;
      if (res.json?.error_code === 'api_key_limit_reached') return { ok: false, reason: 'limit' };
      return { ok: false, reason: 'failed' };
    }
    return { ok: false, reason: 'failed' };
  };
  const pending = attempt().finally(() => memory.pendingKeys.delete(client));
  memory.pendingKeys.set(client, pending);
  return pending;
}
