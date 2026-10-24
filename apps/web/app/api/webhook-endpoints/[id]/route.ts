import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveWebhookAccess, PLAN_REQUIRED_BODY, isUuid, validateInboxIds } from '@/lib/webhooks/access';
import { ENDPOINT_PUBLIC_COLUMNS, endpointJson, webhookDb, type WebhookEndpointRow } from '@/lib/webhooks/db';
import { validateWebhookUrl } from '@/lib/webhooks/url';

/**
 * PATCH  /api/webhook-endpoints/[id]   edit (owner/admin)
 * DELETE /api/webhook-endpoints/[id]   delete, with its delivery log (owner/admin)
 *
 * PATCH body, every field optional:
 *   url          a new https URL (checked like a new one)
 *   inboxIds     null = every inbox; or a non-empty list of this workspace's inboxes
 *   payloadMode  'ids' | 'headers'
 *   enabled      true re-enables (clears the failure run); false turns it off
 *
 * Anything that would make the endpoint deliver (re-enabling, a new URL)
 * needs a plan with webhooks. Turning it off and deleting it never do, so a
 * downgraded workspace can still clean up.
 *
 * Every write is scoped to id AND the caller's active workspace, through the
 * service role, after the role check.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });

  const supabase = await createClient();
  const access = await resolveWebhookAccess(supabase, { manage: true });
  if (!access.ok) return NextResponse.json(access.body, { status: access.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }
  const input = body as { url?: unknown; inboxIds?: unknown; payloadMode?: unknown; enabled?: unknown };

  const service = createServiceRoleClient();
  const hooks = webhookDb(service);
  const update: Partial<WebhookEndpointRow> = {};

  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false.' }, { status: 400 });
  }
  const delivers = input.enabled === true || input.url !== undefined;
  if (delivers && !access.webhooksEnabled) return NextResponse.json(PLAN_REQUIRED_BODY, { status: 403 });

  if (input.url !== undefined) {
    const verdict = await validateWebhookUrl(input.url);
    if (!verdict.ok) return NextResponse.json({ error: verdict.message, error_code: verdict.code }, { status: 400 });
    update.url = verdict.url.href;
  }
  if (Object.hasOwn(input, 'inboxIds')) {
    const inboxes = await validateInboxIds(service, access.workspaceId, input.inboxIds);
    if (!inboxes.ok) return NextResponse.json({ error: inboxes.error, error_code: 'inbox_invalid' }, { status: 400 });
    update.inbox_ids = inboxes.value;
  }
  if (input.payloadMode !== undefined) {
    if (input.payloadMode !== 'ids' && input.payloadMode !== 'headers') {
      return NextResponse.json({ error: 'payloadMode must be "ids" or "headers".' }, { status: 400 });
    }
    update.payload_mode = input.payloadMode;
  }
  if (input.enabled === true) {
    Object.assign(update, { disabled_at: null, disabled_reason: null, consecutive_failures: 0, failing_since: null });
  } else if (input.enabled === false) {
    Object.assign(update, { disabled_at: new Date().toISOString(), disabled_reason: 'manual' as const });
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });
  update.updated_at = new Date().toISOString();

  const { data: row, error } = await hooks
    .from('webhook_endpoints')
    .update(update)
    .eq('id', id)
    .eq('workspace_id', access.workspaceId)
    .select(ENDPOINT_PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error('[webhook-endpoints] update failed:', error.code);
    return NextResponse.json({ error: 'Could not update the webhook.' }, { status: 500 });
  }
  if (!row) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });
  return NextResponse.json(endpointJson(row));
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });

  const supabase = await createClient();
  const access = await resolveWebhookAccess(supabase, { manage: true });
  if (!access.ok) return NextResponse.json(access.body, { status: access.status });

  const { data, error } = await webhookDb(createServiceRoleClient())
    .from('webhook_endpoints')
    .delete()
    .eq('id', id)
    .eq('workspace_id', access.workspaceId)
    .select('id');
  if (error) {
    console.error('[webhook-endpoints] delete failed:', error.code);
    return NextResponse.json({ error: 'Could not delete the webhook.' }, { status: 500 });
  }
  if (!data || data.length === 0) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
