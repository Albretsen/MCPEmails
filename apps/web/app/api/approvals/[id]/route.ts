import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isUnsendableLegacyDraft, readPayload, readSummary, reviewerBccFor } from '@/lib/approvals/payload';
import { neutralizeList, neutralizeText } from '@/lib/textSafety';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One pending approval, as the dashboard decision dialog shows it.
 *
 * The queue (`GET /api/approvals`) lists summaries and decrypts nothing. When
 * an owner or admin opens the dialog for one send, this returns what they are
 * deciding on: the current recipients and subject, the Bcc ADDRESSES (security
 * review 2026-10-16, F-04-05; a count let a hidden recipient be approved
 * blind), the `revision` the decision must carry, and whether it can be
 * approved at all. One decrypt, for the row actually being looked at.
 *
 * Read-only and side-effect free. The workspace is resolved from the approval
 * row, and a missing approval and one in a workspace the user is not a member
 * of return the same 404. `viewer` gets the count and no addresses, as on the
 * review page.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id ?? '')) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const db = createServiceRoleClient();
  const { data: approval } = await db
    .from('send_approvals')
    .select('id, workspace_id, operation, summary, status, revision, payload, payload_encrypted')
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

  const summary = readSummary(approval.summary);
  const payload = readPayload(approval);
  const bcc = reviewerBccFor(approval, membership.role);
  const summaryBccCount = typeof summary.bcc_count === 'number' ? summary.bcc_count : 0;

  return NextResponse.json(
    {
      id: approval.id,
      status: approval.status,
      revision: approval.revision,
      to: neutralizeList(summary.to).filter(Boolean),
      cc: neutralizeList(summary.cc).filter(Boolean),
      subject: neutralizeText(typeof summary.subject === 'string' ? summary.subject : ''),
      bcc,
      bcc_count: Math.max(summaryBccCount, bcc.length),
      approvable: !isUnsendableLegacyDraft(approval, payload),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
