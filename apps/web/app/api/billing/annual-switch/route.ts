import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { annualSwitchMode } from '@/lib/billing/annual-switch';
import { recordAnnualSwitchSeen, type AnnualSwitchSurface } from '@/lib/analytics/billing-funnel';

/**
 * POST /api/billing/annual-switch
 *
 * The dashboard's monthly-to-annual card and notice report here
 * (src/lib/billing/annual-switch.ts). Body: `{ event, surface, workspaceId }`.
 *
 *   event     'shown' | 'clicked' | 'dismissed'
 *   surface   'billing' (the permanent card) | 'overview' (the notice)
 *
 * shown/clicked write the funnel rows annual_switch_shown / _clicked
 * (category dashboard_billing | surface_overview). dismissed stamps the
 * workspace's dismissal columns; only the Overview notice can be dismissed.
 * annual_switch_completed is written by checkout-core when Stripe has
 * collected the switch, never from here.
 *
 * Only the workspace OWNER may write (the card is shown to nobody else). With
 * ANNUAL_SWITCH_CARD_ENABLED off the route answers 404, like the other
 * flagged billing routes. Nothing here charges or changes a subscription.
 */
export const dynamic = 'force-dynamic';

const EVENTS = new Set(['shown', 'clicked', 'dismissed']);
const SURFACES: Record<string, AnnualSwitchSurface> = {
  billing: 'dashboard_billing',
  overview: 'surface_overview',
};

function json(body: unknown, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

interface WorkspaceRow {
  id: string;
  owner_id: string;
  annual_switch_dismiss_count: number | null;
}

/**
 * The two new columns are not in the generated types until `npm run
 * gen:types` runs after the migration, so this table access is narrowed here.
 */
type WorkspacesDb = {
  from(table: 'workspaces'): {
    select(columns: string): {
      eq(column: string, value: string): {
        is(column: string, value: null): {
          maybeSingle(): PromiseLike<{ data: WorkspaceRow | null; error: { message: string } | null }>;
        };
      };
    };
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (annualSwitchMode() !== 'on') return json({ error: 'Not found' }, 404);
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const body = (await request.json().catch(() => null)) as
      | { event?: unknown; surface?: unknown; workspaceId?: unknown }
      | null;
    const event = typeof body?.event === 'string' && EVENTS.has(body.event) ? body.event : null;
    const surface = typeof body?.surface === 'string' ? SURFACES[body.surface] ?? null : null;
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : null;
    if (!event || !surface || !workspaceId) return json({ error: 'Invalid request.' }, 400);
    // The billing card is permanent: it has no close button and no column.
    if (event === 'dismissed' && surface !== 'surface_overview') {
      return json({ error: 'Invalid request.' }, 400);
    }

    const db = createServiceRoleClient() as unknown as WorkspacesDb;
    const { data: workspace, error } = await db
      .from('workspaces')
      .select('id, owner_id, annual_switch_dismiss_count')
      .eq('id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      console.error('[annual-switch] workspace read failed', { error: error.message });
      return json({ error: 'Something went wrong.' }, 500);
    }
    if (!workspace || workspace.owner_id !== user.id) return json({ error: 'Not found' }, 404);

    if (event === 'dismissed') {
      const count = Math.min(2, (workspace.annual_switch_dismiss_count ?? 0) + 1);
      const { error: updateError } = await db
        .from('workspaces')
        .update({ annual_switch_dismissed_at: new Date().toISOString(), annual_switch_dismiss_count: count })
        .eq('id', workspace.id);
      if (updateError) {
        console.error('[annual-switch] dismissal write failed', { error: updateError.message });
        return json({ error: 'Something went wrong.' }, 500);
      }
      return json({ ok: true }, 200);
    }

    await recordAnnualSwitchSeen(workspace.id, event as 'shown' | 'clicked', surface);
    return json({ ok: true }, 200);
  } catch (err) {
    console.error('[annual-switch] route failed', { error: err instanceof Error ? err.message : String(err) });
    return json({ error: 'Something went wrong.' }, 500);
  }
}
