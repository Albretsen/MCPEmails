/**
 * POST /api/support/article-feedback: the "Was this helpful?" answer under a
 * help article. Body: `{ articleId, locale, helpful }`.
 *
 * A well-formed vote answers 204 whether or not it was stored: the article
 * says thanks either way, and a failed write must never look like a broken
 * page. A well-formed vote for an article id that does not exist is also 204,
 * with no write. A malformed body (not JSON, over 1 KB, a missing or oversized
 * id, a non-boolean `helpful`, a locale that is not a help locale) is 400.
 * HelpCenter.jsx fires and forgets, so the status never reaches the reader.
 *
 * SUPPORT_RELEASE_GATE: hidden callers get the unmatched 404 on every method.
 */
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  createSupabaseArticleFeedbackStore,
  parseArticleFeedback,
  voterKey,
} from '@/lib/support/article-feedback';
import { supportJson, supportMethodNotAllowed, supportNotFound } from '@/lib/support/http';
import { clientIp, hashSupportIp } from '@/lib/support/ip';
import { readBodyWithLimit } from '@/lib/support/read-body';
import { getSupportViewer } from '@/lib/support/viewer';

const MAX_BODY_BYTES = 1024;

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE

  const read = await readBodyWithLimit(request, MAX_BODY_BYTES);
  if (!read.ok) return supportJson({ error: read.reason === 'too_large' ? 'body_too_large' : 'invalid_body' }, 400);
  let body: unknown = null;
  try {
    body = JSON.parse(read.text);
  } catch {
    return supportJson({ error: 'invalid_body' }, 400);
  }
  try {
    const parsed = await parseArticleFeedback(body);
    if (parsed.kind === 'invalid') return supportJson({ error: parsed.error }, 400);
    if (parsed.kind === 'unknown_article') return noContent();
    const vote = parsed.vote;
    const userId = viewer.user?.id ?? null;
    const key = voterKey(userId, userId ? null : hashSupportIp(clientIp(request.headers)));
    if (!key) return noContent();

    await createSupabaseArticleFeedbackStore(createServiceRoleClient()).upsert({
      article_id: vote.articleId,
      locale: vote.locale,
      helpful: vote.helpful,
      voter_key: key,
      user_id: userId,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[help-feedback] record failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return noContent();
}

async function otherMethod(): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE
  return supportMethodNotAllowed('POST');
}

export const GET = otherMethod;
export const HEAD = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
