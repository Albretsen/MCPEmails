import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';

const MAX_REASON_LENGTH = 500;
const MAX_TICKET_LENGTH = 200;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  await requireAdmin();
  const workspaceId = request.nextUrl.searchParams.get('workspace_id');
  const service = createServiceRoleClient();
  let query = service.from('workspace_usage_exemptions').select('id, workspace_id, reason, ticket_id, granted_at, expires_at, revoked_at, revoke_reason').order('granted_at', { ascending: false });
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, error } = await query.limit(100);
  if (error) return NextResponse.json({ error: 'Could not load usage exemptions.' }, { status: 500 });
  return NextResponse.json({ exemptions: data ?? [] });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin();
  const body = await request.json().catch(() => null);
  const workspaceId = text(body?.workspace_id, 36);
  const reason = text(body?.reason, MAX_REASON_LENGTH);
  const ticketId = text(body?.ticket_id, MAX_TICKET_LENGTH);
  const expiresAt = body?.expires_at === null || body?.expires_at === undefined ? null : text(body.expires_at, 64);
  if (!workspaceId || !reason || !ticketId || (expiresAt && Number.isNaN(new Date(expiresAt).getTime()))) {
    return NextResponse.json({ error: 'workspace_id, reason, ticket_id, and a valid expires_at are required.' }, { status: 400 });
  }
  const service = createServiceRoleClient();
  const { data, error } = await service.from('workspace_usage_exemptions').insert({
    workspace_id: workspaceId, reason, ticket_id: ticketId, granted_by: admin.id, expires_at: expiresAt,
  }).select('id, workspace_id, granted_at, expires_at').single();
  if (error) return NextResponse.json({ error: 'Could not create usage exemption.' }, { status: 500 });
  return NextResponse.json({ exemption: data }, { status: 201 });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin();
  const body = await request.json().catch(() => null);
  const exemptionId = text(body?.id, 36);
  const revokeReason = text(body?.revoke_reason, MAX_REASON_LENGTH);
  if (!exemptionId || !revokeReason) return NextResponse.json({ error: 'id and revoke_reason are required.' }, { status: 400 });
  const { data, error } = await createServiceRoleClient().from('workspace_usage_exemptions')
    .update({ revoked_at: new Date().toISOString(), revoked_by: admin.id, revoke_reason: revokeReason })
    .eq('id', exemptionId).is('revoked_at', null).select('id, revoked_at').maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not revoke usage exemption.' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Active usage exemption not found.' }, { status: 404 });
  return NextResponse.json({ exemption: data });
}
