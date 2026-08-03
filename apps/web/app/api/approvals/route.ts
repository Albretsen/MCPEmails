import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return null;
  // The send_approvals migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const { data: membership } = await db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  return membership ? { user, workspaceId, role: membership.role, db } : null;
}

export async function GET() {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const { data, error } = await c.db.from('send_approvals')
    .select('id, inbox_id, operation, summary, send_at, status, created_at, inboxes(email_address, display_name)')
    .eq('workspace_id', c.workspaceId).eq('status', 'pending').order('created_at', { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: 'Failed to load approvals.' }, { status: 500 });
  return NextResponse.json({ approvals: data ?? [] });
}

export async function PATCH(request: NextRequest) {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!['owner', 'admin'].includes(c.role)) return NextResponse.json({ error: 'Only workspace owners and admins can decide sends.' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const id = body?.id; const decision = body?.decision;
  if (typeof id !== 'string' || !['approve', 'reject'].includes(decision)) return NextResponse.json({ error: 'An approval id and decision are required.' }, { status: 400 });
  const { data: approval, error } = await c.db.from('send_approvals').select('*').eq('id', id).eq('workspace_id', c.workspaceId).eq('status', 'pending').maybeSingle();
  if (error || !approval) return NextResponse.json({ error: 'This approval is no longer pending.' }, { status: 409 });
  const now = new Date().toISOString();
  if (decision === 'approve') {
    const { data: claimed, error: claimError } = await c.db.from('send_approvals')
      .update({ status: 'approved', decided_at: now, decided_by: c.user.id })
      .eq('id', id).eq('status', 'pending').select('id').maybeSingle();
    if (claimError || !claimed) return NextResponse.json({ error: 'This approval is no longer pending.' }, { status: 409 });
    // The edge dispatcher resolves the encrypted approval snapshot and invokes
    // its original outbound operation. This marker contains no email content.
    const { error: queued } = await c.db.from('scheduled_sends').insert({ workspace_id: c.workspaceId, inbox_id: approval.inbox_id, payload: { approval_id: approval.id }, payload_encrypted: false, send_at: approval.send_at ?? now, status: 'pending' });
    if (queued) {
      await c.db.from('send_approvals').update({ status: 'pending', decided_at: null, decided_by: null }).eq('id', id).eq('status', 'approved');
      return NextResponse.json({ error: 'Could not queue this approved email.' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }
  const { error: updated } = await c.db.from('send_approvals').update({ status: 'rejected', decided_at: now, decided_by: c.user.id }).eq('id', id).eq('status', 'pending');
  if (updated) return NextResponse.json({ error: 'Could not record decision.' }, { status: 500 });
  return NextResponse.json({ success: true });
}
