/**
 * The connect link the MCP server hands a chat when a tool is called before
 * any mailbox is connected (supabase/functions/mcp-server/no-inbox-answer.ts):
 *
 *   /dashboard/inboxes?from=chat&client=<chip id>&provider=<guess>&exp=<unix s>&sig=<…>
 *
 * The signature is checked here against the signed-in user's ACTIVE workspace.
 * Only a link that verifies, has not expired and names this workspace turns on
 * "from chat" mode (the connect step alone, then "Connected. Go back to Claude
 * and ask again"). Anything else is an ordinary dashboard visit: the provider
 * hint still preselects its card, nothing more. Server only (ENCRYPTION_KEY).
 *
 * key = HMAC-SHA256(ENCRYPTION_KEY bytes, "mcpe-chat-connect-link-v1")
 * sig = base64url-nopad(HMAC-SHA256(key, "v1|<workspace>|<exp>|<provider>|<client>"))
 *
 * mcp-server mirrors this; the shared vector is in chat-connect-link.test.ts
 * and no-inbox-answer.test.ts. Change both or neither.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { normalizeChipClient } from './clients.mjs';
import { connectIntentSlugShape } from '@/lib/connect/intent-carry.mjs';

const SIGNING_LABEL = 'mcpe-chat-connect-link-v1';

/** The query value that marks a link from a chat. */
export const FROM_CHAT = 'chat';

/** The parameters a chat connect link carries; carried on to /onboarding unchanged. */
export const CHAT_LINK_PARAMS = ['from', 'client', 'provider', 'exp', 'sig'] as const;

export interface ChatReturn {
  /** The chip id of the AI app the link came from, or null when it did not say. */
  client: string | null;
  /** The provider slug hint, or null. */
  provider: string | null;
}

function keyBytes(hex: string | undefined | null): Buffer | null {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0 || clean.length < 32) return null;
  return Buffer.from(clean, 'hex');
}

export function chatConnectPayload(workspaceId: string, exp: number, provider: string | null, client: string | null): string {
  return `v1|${workspaceId.toLowerCase()}|${exp}|${provider ?? ''}|${client ?? ''}`;
}

/** The signature for these values, or null when the key is unusable. */
export function signChatConnectLink(
  keyHex: string | undefined | null,
  workspaceId: string,
  exp: number,
  provider: string | null,
  client: string | null,
): string | null {
  const secret = keyBytes(keyHex);
  if (!secret) return null;
  const signingKey = createHmac('sha256', secret).update(SIGNING_LABEL).digest();
  return createHmac('sha256', signingKey).update(chatConnectPayload(workspaceId, exp, provider, client)).digest('base64url');
}

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | null {
  const value = params[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The chat return this request is entitled to, or null. Requires from=chat, a
 * future `exp`, and a signature over exactly these values for `workspaceId`.
 */
export function verifyChatConnectLink(
  params: Params,
  workspaceId: string | null | undefined,
  options: { keyHex?: string | null; nowMs?: number } = {},
): ChatReturn | null {
  if (one(params, 'from') !== FROM_CHAT || !workspaceId) return null;
  const sig = one(params, 'sig');
  const expRaw = one(params, 'exp');
  if (!sig || !expRaw || !/^\d{1,12}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  if (exp * 1000 <= (options.nowMs ?? Date.now())) return null;

  const rawClient = one(params, 'client');
  const rawProvider = one(params, 'provider');
  const client = normalizeChipClient(rawClient);
  const provider = connectIntentSlugShape(rawProvider);
  // A value that is present but not one we would have signed fails outright.
  if ((rawClient && !client) || (rawProvider && !provider)) return null;

  const expected = signChatConnectLink(
    options.keyHex === undefined ? process.env.ENCRYPTION_KEY : options.keyHex,
    workspaceId, exp, provider, client,
  );
  if (!expected) return null;
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { client, provider };
}

/** `path` with every chat-link parameter present in `params` appended. */
export function withChatLinkParams(path: string, params: Params): string {
  const url = new URL(path, 'https://x.invalid');
  for (const key of CHAT_LINK_PARAMS) {
    const value = one(params, key);
    if (value) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}
