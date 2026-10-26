/**
 * The visitor's AI assistant for this render. Server only: reads next/headers.
 * Nothing a unit test loads may import this file. See preferred.mjs.
 */
import { cookies, headers } from 'next/headers';
import { getClient } from './clients.mjs';
import { AI_CLIENT_COOKIE, AI_CLIENT_HEADER, normalizeAiClient } from './preferred.mjs';

/**
 * Header first (set by proxy.ts from this request's own utm_source or Referer,
 * so the very first page view already has it), then the cookie from an
 * earlier visit. Null when neither names an AI client we have a page for.
 */
export async function getPreferredClient(): Promise<string | null> {
  const fromHeader = normalizeAiClient((await headers()).get(AI_CLIENT_HEADER));
  const slug = fromHeader ?? normalizeAiClient((await cookies()).get(AI_CLIENT_COOKIE)?.value);
  return slug && getClient(slug) ? slug : null;
}
