/**
 * POST /api/support/article-feedback: the "Was this helpful?" answer under a
 * help article. Body: `{ articleId, locale, helpful }`.
 *
 * Answers 204 whether or not the vote was stored, like the other feedback
 * beacons: the article says thanks either way, and a failed write must never
 * look like a broken page. A body that is not a vote for a real article is
 * dropped without a write.
 *
 * SUPPORT_RELEASE_GATE: hidden callers get the unmatched 404 on every method.
 */
import { createServiceRoleClient } from '@/lib/supabase/service';
import {
  createSupabaseArticleFeedbackStore,
  parseArticleFeedback,
  voterKey,
} from '@/lib/support/article-feedback';
import { supportMethodNotAllowed, supportNotFound } from '@/lib/support/http';
import { clientIp, hashSupportIp } from '@/lib/support/ip';
import { getSupportViewer } from '@/lib/support/viewer';

const MAX_BODY_BYTES = 1024;

function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE

  try {
    const raw = await request.text().catch(() => '');
    if (raw.length > MAX_BODY_BYTES) return noContent();
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return noContent();
    }
    const vote = await parseArticleFeedback(body);
    if (!vote) return noContent();
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
