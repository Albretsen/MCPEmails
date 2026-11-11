import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import { parseHeardAboutBody } from '@/lib/onboarding/heard-about.mjs';

/**
 * POST /api/onboarding/heard-about
 *
 *   { answer: '<option id>', other?: string }  save the answer
 *   { dismiss: true }                           never ask this workspace again
 *
 * The "How did you hear about MCPEmails?" card on the dashboard Overview
 * (components/dashboard/HeardAboutCard.jsx, src/lib/onboarding/heard-about.mjs).
 *
 * MEMBERS ONLY, ONCE. The active workspace is resolved through the user's own
 * session (workspace_members, RLS), and membership is checked again with the
 * service role before the write. workspaces is server-owned (no grant to
 * authenticated, 20261016160100), so the write is the service role's, and it is
 * conditional on heard_about_at IS NULL: an answer or a dismissal is final, and
 * a second POST changes nothing and answers 409.
 *
 * Writes one product_funnel_events row (heard_about_answered or
 * heard_about_dismissed, category surface_overview) when the stamp lands.
 */

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'Unauthorized.' }, 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  const parsed = parseHeardAboutBody(raw);
  if (!parsed.ok) return json({ error: 'Invalid request.', code: parsed.error }, 400);

  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return json({ error: 'Workspace not found.' }, 404);

  const db = createServiceRoleClient();
  const { data: member } = await db
    .from('workspace_members')
    .select('workspace_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!member) return json({ error: 'Workspace not found.' }, 404);

  const now = new Date().toISOString();
  const patch = parsed.kind === 'dismiss'
    ? { heard_about: null, heard_about_other: null, heard_about_at: now }
    : { heard_about: parsed.answer, heard_about_other: parsed.other, heard_about_at: now };

  const { data: updated, error } = await db
    .from('workspaces')
    .update(patch)
    .eq('id', workspaceId)
    .is('heard_about_at', null)
    .is('deleted_at', null)
    .select('id');
  if (error) {
    console.error('[heard-about] update failed', { error: error.message });
    return json({ error: 'Could not save.' }, 500);
  }
  if (!updated || updated.length === 0) return json({ error: 'Already answered.' }, 409);

  await recordProductFunnelEvent(db, {
    workspaceId,
    stage: parsed.kind === 'dismiss' ? 'heard_about_dismissed' : 'heard_about_answered',
    outcome: 'success',
    category: 'surface_overview',
  });
  return json({ ok: true });
}
