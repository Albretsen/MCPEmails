import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveWebhookAccess, isUuid } from '@/lib/webhooks/access';
import { DELIVERY_LOG_LIMIT, DELIVERY_PUBLIC_COLUMNS, webhookDb } from '@/lib/webhooks/db';

/**
 * GET /api/webhook-endpoints/[id]/deliveries
 *
 * The endpoint's last 100 delivery attempts, newest first, for any member:
 * event id and type, inbox, attempt count, status, the receiver's status
 * code, an error code and the next retry. No content: there is none to
 * return (the pending message ids are not granted to browser sessions).
 * Read through the user client, so RLS decides what is visible.
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });

  const supabase = await createClient();
  const access = await resolveWebhookAccess(supabase, { manage: false });
  if (!access.ok) return NextResponse.json(access.body, { status: access.status });

  const hooks = webhookDb(supabase);
  const { data: endpoint } = await hooks
    .from('webhook_endpoints')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', access.workspaceId)
    .maybeSingle();
  if (!endpoint) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });

  const { data, error } = await hooks
    .from('webhook_deliveries')
    .select(DELIVERY_PUBLIC_COLUMNS)
    .eq('endpoint_id', id)
    .eq('workspace_id', access.workspaceId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(DELIVERY_LOG_LIMIT);
  if (error) {
    console.error('[webhook-endpoints] deliveries failed:', error.code);
    return NextResponse.json({ error: 'Could not load deliveries.' }, { status: 500 });
  }
  return NextResponse.json({
    deliveries: (data ?? []).map((d) => ({
      id: d.id,
      eventId: d.event_id,
      eventType: d.event_type,
      inboxId: d.inbox_id,
      messageCount: d.message_count,
      attempt: d.attempt,
      status: d.status,
      responseCode: d.response_code,
      errorCode: d.error_code,
      nextAttemptAt: d.next_attempt_at,
      createdAt: d.created_at,
      lastAttemptAt: d.last_attempt_at,
      deliveredAt: d.delivered_at,
    })),
  });
}
