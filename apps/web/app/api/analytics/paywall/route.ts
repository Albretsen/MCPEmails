import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { primaryWorkspaceId, recordInboxPaywallReached } from '@/lib/analytics/billing-funnel';
import { connectEntryPoint } from '@/lib/analytics/product-funnel';

/**
 * POST /api/analytics/paywall   body (optional): {"entry_point": "<closed list>"}
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
 *   - The only thing read from the request is `entry_point`: which control
 *     opened the modal, one word from a closed list
 *     (lib/analytics/connect-entry-point.mjs). Anything else, including a
 *     missing or malformed body, is stored as NULL and the row is still
 *     written. So the address, provider or server details of the mailbox the
 *     user was about to connect cannot reach the funnel even by accident. The
 *     plan recorded on the row is read from the database, never from the
 *     browser.
 *
 * Always returns 204. A beacon must never surface an error to the page, and a
 * failed analytics write must never look like a broken upgrade panel.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return noContent;

    // A body-less beacon (an older tab still open across the deploy) is a
    // paywall view all the same.
    const body = await request.json().catch(() => null);
    await recordInboxPaywallReached(
      await primaryWorkspaceId(supabase, user.id),
      connectEntryPoint(body?.entry_point),
    );
  } catch (err) {
    console.error('[paywall-beacon] record failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return noContent;
}
