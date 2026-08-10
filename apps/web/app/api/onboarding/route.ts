import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { onboardingActionPayload } from '@/lib/onboarding/state';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 }); }
  const action = body.action;
  if (action !== 'started' && action !== 'client_selected' && action !== 'provider_selected') {
    return NextResponse.json({ error: 'Unsupported onboarding action.' }, { status: 400 });
  }
  const payload = onboardingActionPayload(action, action === 'client_selected' ? body.client : body.provider);
  if (!payload) return NextResponse.json({ error: 'Invalid onboarding category.' }, { status: 400 });

  const now = new Date().toISOString();
  const db = createServiceRoleClient();
  const workspaces = db.from('workspaces');
  if (action === 'started') {
    const { data: claimed } = await workspaces.update({ onboarding_started_at: now }).eq('id', workspaceId).is('onboarding_started_at', null).select('id');
    if (claimed?.length) await recordProductFunnelEvent(db, { workspaceId, stage: 'onboarding_started', outcome: 'success', category: 'unknown' });
  } else if (action === 'client_selected') {
    const client = payload.client as string;
    await workspaces.update({ onboarding_client: client, onboarding_client_selected_at: now }).eq('id', workspaceId);
    await workspaces.update({ onboarding_stage: 'client_selected' }).eq('id', workspaceId).eq('onboarding_stage', 'started');
    await recordProductFunnelEvent(db, { workspaceId, stage: 'client_selected', outcome: 'success', category: client as Parameters<typeof recordProductFunnelEvent>[1]['category'] });
  } else {
    const provider = payload.provider as string;
    await workspaces.update({ onboarding_provider: provider }).eq('id', workspaceId);
    await recordProductFunnelEvent(db, { workspaceId, stage: 'provider_selected', outcome: 'success', category: provider as Parameters<typeof recordProductFunnelEvent>[1]['category'] });
  }
  return NextResponse.json({ ok: true });
}
