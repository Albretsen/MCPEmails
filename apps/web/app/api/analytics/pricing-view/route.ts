import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { primaryWorkspaceId, recordPricingViewed } from '@/lib/analytics/billing-funnel';

/**
 * POST /api/analytics/pricing-view
 *
 * Records that a SIGNED-IN user looked at the plans, so the billing funnel can
 * separate "never considered paying" from "considered it and did not convert".
 *
 * Scope and privacy:
 *   - Authenticated only. Anonymous /pricing traffic is a marketing-analytics
 *     question and is deliberately not written to the product funnel, whose
 *     `workspace_id` is NOT NULL by design.
 *   - The only client-supplied value is `surface`, validated against a two-item
 *     allow-list. Nothing else from the request is persisted: no referrer, no
 *     query string, no IP, no user agent.
 *   - Deduped server-side to one row per workspace / surface / UTC day, so a
 *     refresh loop or a pinned dashboard tab cannot manufacture intent.
 *
 * Always returns 204. A beacon must never surface an error to the page, and an
 * analytics failure must never look like a broken pricing page.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return noContent;

    const body: unknown = await request.json().catch(() => null);
    const surface = (body as Record<string, unknown> | null)?.surface;
    if (surface !== 'pricing_page' && surface !== 'dashboard_billing') return noContent;

    await recordPricingViewed(await primaryWorkspaceId(supabase, user.id), surface);
  } catch (err) {
    console.error('[pricing-view] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return noContent;
}
