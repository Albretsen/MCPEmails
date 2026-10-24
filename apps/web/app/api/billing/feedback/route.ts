/**
 * POST /api/billing/feedback: why a subscriber cancelled, after the fact.
 *
 * Body: `{ t?, reason, detail? }`.
 *   - With `t` (the signed token from the post-cancel email link): public, no
 *     session. The token names the cancellation; source 'cancel_email'.
 *   - Without `t`: the signed-in caller's own subscription, read from
 *     `user_billing`; source 'billing_card' (the Billing card UI that follows
 *     in the pause/downgrade work).
 *
 * POST only. The page that links here (/billing/feedback) never writes on GET,
 * because mail link scanners prefetch every URL in an email; the answer is
 * recorded only when a person presses Send. Every other method is a 405.
 *
 * Abuse is bounded by the token's MAC, one row per cancellation (a resubmit
 * replaces the answer) and a per-IP rate limit like the other public POSTs.
 * The flow lives in src/lib/billing/cancellation-feedback.ts.
 */
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import { primaryWorkspaceId, recordCancelReasonSubmitted } from '@/lib/analytics/billing-funnel';
import { submitCancellationFeedback } from '@/lib/billing/cancellation-feedback';
import { createFeedbackServiceClient, upsertCancellationFeedback } from '@/lib/billing/feedback-db';
import { supportJson, supportMethodNotAllowed } from '@/lib/support/http';
import { clientIp, hashSupportIp } from '@/lib/support/ip';

/** Far above any valid request (a 500-character CJK answer is ~1.5 KB). */
const MAX_BODY_BYTES = 8 * 1024;
const RATE_LIMIT_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export async function POST(request: Request): Promise<Response> {
  const ipKey = hashSupportIp(clientIp(request.headers)) ?? 'unknown';
  if (await checkRateLimit(`billing-feedback:${ipKey}`, RATE_LIMIT_PER_HOUR, HOUR_MS)) {
    return supportJson({ ok: false, error: 'rate_limited' }, 429);
  }

  const rawBody = await request.text().catch(() => '');
  if (rawBody.length > MAX_BODY_BYTES) return supportJson({ ok: false, error: 'invalid_body' }, 400);
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return supportJson({ ok: false, error: 'invalid_body' }, 400);
  }

  let service;
  let feedbackDb;
  try {
    service = createServiceRoleClient();
    feedbackDb = createFeedbackServiceClient();
  } catch (err) {
    console.error('[billing-feedback] service client unavailable:', err instanceof Error ? err.message : String(err));
    return supportJson({ ok: false, error: 'server_error' }, 500);
  }

  const outcome = await submitCancellationFeedback(body, {
    async sessionUserId() {
      try {
        const supabase = await createClient();
        const { data } = await supabase.auth.getUser();
        return data.user?.id ?? null;
      } catch {
        return null;
      }
    },
    async billingForUser(userId) {
      const { data, error } = await service
        .from('user_billing')
        .select('user_id, stripe_subscription_id, stripe_customer_id, current_period_end')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) console.error('[billing-feedback] billing read failed', { message: error.message });
      if (!data) return null;
      return {
        userId: data.user_id,
        subscriptionId: data.stripe_subscription_id,
        customerId: data.stripe_customer_id,
        periodEnd: data.current_period_end,
      };
    },
    async userIdForCustomer(customerId) {
      const { data, error } = await service
        .from('user_billing')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .limit(1)
        .maybeSingle();
      if (error) console.error('[billing-feedback] customer lookup failed', { message: error.message });
      return data?.user_id ?? null;
    },
    upsert: (row) => upsertCancellationFeedback(feedbackDb, row),
    async recordFunnel(userId, reason) {
      try {
        await recordCancelReasonSubmitted(await primaryWorkspaceId(service, userId), reason);
      } catch (err) {
        console.error('[billing-feedback] funnel record failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
    now: Date.now,
  });
  return supportJson(outcome.body, outcome.status);
}

async function otherMethod(): Promise<Response> {
  return supportMethodNotAllowed('POST');
}

export const GET = otherMethod;
export const HEAD = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
