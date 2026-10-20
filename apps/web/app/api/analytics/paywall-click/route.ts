import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { primaryWorkspaceId, recordInboxPaywallClicked } from '@/lib/analytics/billing-funnel';

/**
 * POST /api/analytics/paywall-click
 *
 * Records that a buy button on the inbox-cap offer was clicked, the second
 * half of POST /api/analytics/paywall (shown). For a Pro workspace at its
 * 10-inbox cap the only offer is Business, so this is the "Business offer
 * clicked" event the Pro cap read-out needs.
 *
 * Same scope and privacy as the shown beacon: authenticated only, no body read,
 * the plan on the row comes from the database. Always 204.
 */
export async function POST(): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return noContent;

    await recordInboxPaywallClicked(await primaryWorkspaceId(supabase, user.id));
  } catch (err) {
    console.error('[paywall-click-beacon] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return noContent;
}
