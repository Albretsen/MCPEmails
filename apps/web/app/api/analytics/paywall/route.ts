import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { primaryWorkspaceId, recordInboxPaywallReached } from '@/lib/analytics/billing-funnel';
import { checkInboxLimit } from '@/lib/plans/check-inbox-limit';
import { recordInboxCapHit } from '@/lib/plans/inbox-cap-events';

/**
 * POST /api/analytics/paywall
 *
 * Records that the inbox-cap upgrade panel was shown in the connect modal.
 *
 * This is the one surface in the product where a user has already decided to
 * do something and been told to pay for it, and until now it wrote nothing at
 * all: the billing funnel could see checkouts but not the offer that preceded
 * them, so a panel that converts badly looked identical to a panel nobody ever
 * sees. The connect routes' own 402 is deliberately NOT the place for this —
 * that path is only the stale-prop fallback, and it already records an
 * `inbox_connection` failure with `error_category = 'plan_limit'`.
 *
 * Scope and privacy:
 *   - Authenticated only; the funnel's `workspace_id` is NOT NULL by design.
 *   - The request has no body. Nothing the caller sends is persisted, so the
 *     address, provider or server details of the mailbox the user was about to
 *     connect cannot reach the funnel even by accident. The plan recorded on
 *     the row is read from the database, never from the browser.
 *
 * Always returns 204. A beacon must never surface an error to the page, and a
 * failed analytics write must never look like a broken upgrade panel.
 */
export async function POST(): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return noContent;

    const workspaceId = await primaryWorkspaceId(supabase, user.id);
    await recordInboxPaywallReached(workspaceId);
    // A Pro workspace at its cap is a hit for the Pro cap read-out
    // (docs/sql/pro-cap-readout.sql). The modal shows the offer from the page's
    // own count without calling a connect route, so this beacon is where most
    // hits are seen. Re-checked here with the user's client: the browser only
    // says "the panel showed", never what the plan or the count is.
    if (workspaceId) {
      await recordInboxCapHit(workspaceId, await checkInboxLimit(supabase, workspaceId));
    }
  } catch (err) {
    console.error('[paywall-beacon] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return noContent;
}
