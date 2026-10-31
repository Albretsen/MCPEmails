import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { cleanOriginal } from '@/lib/approvals/original';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const NO_STORE = { 'Cache-Control': 'no-store' };

/** A person is waiting, and rejecting must not wait for the mailbox. */
const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * What a held forward would actually send: the original's sender, date, a text
 * preview, and attachment names and sizes. Read from the mailbox on every call and
 * never stored (src/lib/approvals/original.ts).
 *
 * Read-only. The workspace comes from the approval row, a missing approval and one
 * in another workspace answer the same 404, and `viewer` gets no message content,
 * as on the review page (src/lib/approvals/review.ts).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id ?? '')) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const db = createServiceRoleClient();
  const { data: approval } = await db
    .from('send_approvals')
    .select('id, workspace_id')
    .eq('id', id)
    .maybeSingle();
  const { data: membership } = approval
    ? await db
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', approval.workspace_id)
        .eq('user_id', user.id)
        .maybeSingle()
    : { data: null };
  if (!approval || !membership) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (membership.role === 'viewer') {
    return NextResponse.json({ error: 'Your role cannot see message content.', code: 'role' }, { status: 403 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceKey) {
    return NextResponse.json({ status: 'unavailable', reason: 'mailbox' }, { headers: NO_STORE });
  }
  try {
    const upstream = await fetch(`${SUPABASE_URL}/functions/v1/mcp-server/approval-original`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({ approval_id: approval.id, workspace_id: approval.workspace_id }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload = await upstream.json().catch(() => null);
    return NextResponse.json(cleanOriginal(upstream.ok ? payload : null), { headers: NO_STORE });
  } catch {
    // No detail in the log: the request carries a service key, and the mail is not ours to log.
    console.error('[api/approvals/original] upstream request failed');
    return NextResponse.json({ status: 'unavailable', reason: 'mailbox' }, { headers: NO_STORE });
  }
}
