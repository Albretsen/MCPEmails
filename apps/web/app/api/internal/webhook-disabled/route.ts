import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isUuid } from '@/lib/webhooks/access';
import { webhookDb } from '@/lib/webhooks/db';
import { sendWebhookDisabledEmail } from '@/lib/email/webhook-disabled';

/**
 * POST /api/internal/webhook-disabled
 *
 * Called by the client-api edge function (webhooks/notify-disabled.ts) right
 * after a delivery disabled an endpoint for failing. Emails the workspace
 * owner once (Resend idempotency key on endpoint id + disabled_at).
 *
 * AUTH. `X-Dispatch-Secret`, constant-time compared with DISPATCH_SECRET, as
 * /api/internal/growth-expire. The body names an endpoint id and nothing
 * else; the route reads everything it sends from the database, and only
 * mails about an endpoint that really is disabled for failing.
 */

export const dynamic = 'force-dynamic';

function authorised(request: Request): boolean {
  const expected = process.env.DISPATCH_SECRET;
  if (!expected) {
    console.error('[webhook-disabled] DISPATCH_SECRET is not set; refusing every request.');
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(request.headers.get('x-dispatch-secret') ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!authorised(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  let endpointId: unknown;
  try {
    endpointId = ((await request.json()) as { endpoint_id?: unknown } | null)?.endpoint_id;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!isUuid(endpointId)) return NextResponse.json({ error: 'endpoint_id is required.' }, { status: 400 });

  const service = createServiceRoleClient();
  const { data: endpoint } = await webhookDb(service)
    .from('webhook_endpoints')
    .select('id, workspace_id, url, disabled_at, disabled_reason')
    .eq('id', endpointId)
    .maybeSingle();
  if (!endpoint || !endpoint.disabled_at || endpoint.disabled_reason !== 'failing') {
    return NextResponse.json({ sent: false, reason: 'not_disabled_for_failing' });
  }

  const { data: workspace } = await service
    .from('workspaces')
    .select('display_name, owner_id')
    .eq('id', endpoint.workspace_id)
    .maybeSingle();
  if (!workspace?.owner_id) return NextResponse.json({ sent: false, reason: 'no_owner' });

  const { data: owner } = await service.from('users').select('email').eq('id', workspace.owner_id).maybeSingle();
  if (!owner?.email) return NextResponse.json({ sent: false, reason: 'no_owner_email' });

  const sent = await sendWebhookDisabledEmail(owner.email, {
    endpointId: endpoint.id,
    disabledAt: endpoint.disabled_at,
    url: endpoint.url,
    workspaceName: workspace.display_name ?? 'your workspace',
  });
  return NextResponse.json({ sent });
}
