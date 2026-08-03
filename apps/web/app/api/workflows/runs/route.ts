import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/** Operational metadata only; email content is never selected or returned. */
type BulkRunSummary = {
  id: string;
  operation: string;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  cancel_requested_at: string | null;
  created_at: string;
  completed_at: string | null;
  error_code: string | null;
  inboxes: { email_address: string; display_name: string | null } | null;
};

async function getContext() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  return workspaceId ? { workspaceId } : null;
}

export async function GET() {
  const context = await getContext();
  if (!context) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  // The bulk_runs migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const { data, error } = await db
    .from('bulk_runs')
    .select('id, inbox_id, operation, status, total, processed, succeeded, failed, cancel_requested_at, created_at, completed_at, error_code, inboxes(email_address, display_name)')
    .eq('workspace_id', context.workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: 'Failed to load runs.' }, { status: 500 });

  return NextResponse.json({ runs: ((data ?? []) as BulkRunSummary[]).map((row) => ({
    id: row.id, operation: row.operation, status: row.status, total: row.total,
    processed: row.processed, succeeded: row.succeeded, failed: row.failed,
    cancelRequestedAt: row.cancel_requested_at, createdAt: row.created_at,
    completedAt: row.completed_at, errorCode: row.error_code,
    inbox: row.inboxes?.display_name ?? row.inboxes?.email_address ?? 'Unknown inbox',
  })) });
}

export async function PATCH(request: NextRequest) {
  const context = await getContext();
  if (!context) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const id = body && typeof body.id === 'string' ? body.id : null;
  if (!id) return NextResponse.json({ error: 'A run id is required.' }, { status: 400 });

  // The bulk_runs migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const now = new Date().toISOString();
  const { data, error } = await db.from('bulk_runs')
    .update({ status: 'cancelling', cancel_requested_at: now })
    .eq('id', id).eq('workspace_id', context.workspaceId).eq('status', 'running')
    .select('id, status').maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not request cancellation.' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'This run has already finished or is unavailable.' }, { status: 409 });
  return NextResponse.json({ run: data });
}
