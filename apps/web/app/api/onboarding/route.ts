import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { normalizeOnboardingClient, onboardingActionPayload } from '@/lib/onboarding/state';
import { connectEntryPoint, recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { STEP_FUNNEL_CATEGORY, isOnboardingStep } from '@/lib/onboarding/flow';
import { normalizeChipClient } from '@/lib/onboarding/clients.mjs';
import { resetOnboarding } from '@/lib/onboarding/reset';
import { isInternalViewer } from '@/lib/onboarding/variant';

type FunnelCategory = Parameters<typeof recordProductFunnelEvent>[1]['category'];

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  const { data, error } = await supabase.from('workspaces').select(
    'onboarding_stage,onboarding_client,onboarding_provider,onboarding_started_at,onboarding_client_selected_at,onboarding_inbox_connected_at,onboarding_connection_verified_at,onboarding_credential_issued_at,onboarding_technical_activated_at,onboarding_value_activated_at'
  ).eq('id', workspaceId).single();
  if (error) return NextResponse.json({ error: 'Could not load onboarding.' }, { status: 500 });
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * POST /api/onboarding  { action, ... }
 *
 * Dashboard actions (unchanged): started, client_selected {client},
 * provider_selected {provider, entry_point?}.
 *
 * /onboarding flow actions (src/lib/onboarding/, WP-C):
 *   step_viewed     {step}    funnel onboarding_step_viewed, category step_<id>
 *   client_changed  {client}  the chip: stores workspaces.onboarding_client,
 *                             funnel client_changed, category = client
 *   completed       {}        stamps onboarding_completed_at once, funnel
 *                             onboarding_completed (the dashboard's "Finish
 *                             setup" link disappears)
 *   reset           {}        internal accounts, owner only: Settings > Reset
 *                             onboarding (src/lib/onboarding/reset.ts)
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
  const action = body.action;
  const now = new Date().toISOString();

  if (action === 'step_viewed') {
    if (!isOnboardingStep(body.step)) return NextResponse.json({ error: 'Invalid step.' }, { status: 400 });
    await recordProductFunnelEvent(createServiceRoleClient(), {
      workspaceId, stage: 'onboarding_step_viewed', outcome: 'success', category: STEP_FUNNEL_CATEGORY[body.step],
    });
    return NextResponse.json({ ok: true });
  }

  if (action === 'client_changed') {
    const client = normalizeChipClient(body.client);
    if (!client || !normalizeOnboardingClient(client)) return NextResponse.json({ error: 'Invalid client.' }, { status: 400 });
    const db = createServiceRoleClient();
    await db.from('workspaces').update({ onboarding_client: client, onboarding_client_selected_at: now }).eq('id', workspaceId);
    await recordProductFunnelEvent(db, { workspaceId, stage: 'client_changed', outcome: 'success', category: client as FunnelCategory });
    return NextResponse.json({ ok: true, client });
  }

  if (action === 'completed') {
    const db = createServiceRoleClient();
    const { data: claimed } = await db.from('workspaces')
      .update({ onboarding_completed_at: now })
      .eq('id', workspaceId)
      .is('onboarding_completed_at', null)
      .select('onboarding_client');
    if (claimed?.length) {
      const client = normalizeOnboardingClient(claimed[0]?.onboarding_client) ?? 'unknown';
      await recordProductFunnelEvent(db, { workspaceId, stage: 'onboarding_completed', outcome: 'success', category: client as FunnelCategory });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === 'reset') {
    const db = createServiceRoleClient();
    // Internal accounts only, and only the workspace owner: a reset rewinds
    // workspace-wide markers.
    const { data: ws } = await db.from('workspaces').select('owner_id').eq('id', workspaceId).maybeSingle();
    if (!ws || ws.owner_id !== user.id || !(await isInternalViewer(user.email ?? null, db))) {
      return NextResponse.json({ error: 'Not available.' }, { status: 403 });
    }
    const result = await resetOnboarding(db, workspaceId);
    if (!result.ok) return NextResponse.json({ error: 'Could not reset onboarding.' }, { status: 500 });
    await recordProductFunnelEvent(db, { workspaceId, stage: 'onboarding_reset', outcome: 'success', category: 'unknown' });
    return NextResponse.json({ ok: true, resetAt: result.resetAt });
  }

  if (action !== 'started' && action !== 'client_selected' && action !== 'provider_selected') {
    return NextResponse.json({ error: 'Unsupported onboarding action.' }, { status: 400 });
  }
  const payload = onboardingActionPayload(action, action === 'client_selected' ? body.client : body.provider);
  if (!payload) return NextResponse.json({ error: 'Invalid onboarding category.' }, { status: 400 });

  const db = createServiceRoleClient();
  const workspaces = db.from('workspaces');
  if (action === 'started') {
    const { data: claimed } = await workspaces.update({ onboarding_started_at: now }).eq('id', workspaceId).is('onboarding_started_at', null).select('id');
    if (claimed?.length) await recordProductFunnelEvent(db, { workspaceId, stage: 'onboarding_started', outcome: 'success', category: 'unknown' });
  } else if (action === 'client_selected') {
    const client = payload.client as string;
    await workspaces.update({ onboarding_client: client, onboarding_client_selected_at: now }).eq('id', workspaceId);
    await workspaces.update({ onboarding_stage: 'client_selected' }).eq('id', workspaceId).eq('onboarding_stage', 'started');
    await recordProductFunnelEvent(db, { workspaceId, stage: 'client_selected', outcome: 'success', category: client as FunnelCategory });
  } else {
    const provider = payload.provider as string;
    await workspaces.update({ onboarding_provider: provider }).eq('id', workspaceId);
    // Which control opened the connect modal this provider was picked in: one
    // word from a closed list, null for anything else.
    await recordProductFunnelEvent(db, { workspaceId, stage: 'provider_selected', outcome: 'success', category: provider as FunnelCategory, entryPoint: connectEntryPoint(body.entry_point) });
  }
  return NextResponse.json({ ok: true });
}
