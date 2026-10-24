import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import { decryptToken } from '@/lib/crypto';
import { resolveWebhookAccess, PLAN_REQUIRED_BODY, isUuid } from '@/lib/webhooks/access';
import { postWebhook } from '@/lib/webhooks/send';
import { EVENT_ID_HEADER, EVENT_TYPE_HEADER, SIGNATURE_HEADER, newEventId, signatureHeader } from '@/lib/webhooks/sign';

/**
 * POST /api/webhook-endpoints/[id]/test
 *
 * Sends one signed `ping` event to the endpoint, now, and answers with what
 * the receiver said. Owner/admin, Pro or Business. Works on a disabled
 * endpoint too, so its owner can check a fix before turning it back on.
 *
 *   { id, type: "ping", created_at, workspace_id, endpoint_id }
 *
 * Same signature, headers, SSRF checks, 10 second deadline and no-redirect
 * rule as a real delivery (lib/webhooks/send.ts). The attempt is written to
 * the delivery log; it never counts toward the endpoint's failure run.
 */

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });

  const supabase = await createClient();
  const access = await resolveWebhookAccess(supabase, { manage: true });
  if (!access.ok) return NextResponse.json(access.body, { status: access.status });
  if (!access.webhooksEnabled) return NextResponse.json(PLAN_REQUIRED_BODY, { status: 403 });

  if (await checkRateLimit(`webhooks:test:${id}`, 10, 600_000)) {
    return NextResponse.json({ error: 'Too many test events. Try again in a few minutes.' }, { status: 429 });
  }

  const hooks = createServiceRoleClient();
  const { data: endpoint, error } = await hooks
    .from('webhook_endpoints')
    .select('id, workspace_id, url, secret_ciphertext')
    .eq('id', id)
    .eq('workspace_id', access.workspaceId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not send the test event.' }, { status: 500 });
  if (!endpoint) return NextResponse.json({ error: 'Webhook not found.' }, { status: 404 });

  let secret: string;
  try {
    secret = decryptToken(endpoint.secret_ciphertext);
  } catch {
    console.error('[webhook-endpoints] secret could not be decrypted for', endpoint.id);
    return NextResponse.json({ error: 'Could not send the test event.' }, { status: 500 });
  }

  const eventId = newEventId();
  const createdAt = new Date().toISOString();
  const body = JSON.stringify({
    id: eventId,
    type: 'ping',
    created_at: createdAt,
    workspace_id: endpoint.workspace_id,
    endpoint_id: endpoint.id,
  });
  const result = await postWebhook({
    url: endpoint.url,
    body,
    headers: {
      [SIGNATURE_HEADER]: signatureHeader(secret, Date.now() / 1000, body),
      [EVENT_ID_HEADER]: eventId,
      [EVENT_TYPE_HEADER]: 'ping',
    },
  });

  const ok = result.kind === 'response' && result.status >= 200 && result.status < 300;
  const status = result.kind === 'response' ? result.status : null;
  const errorCode = ok
    ? null
    : result.kind === 'error'
      ? result.code
      : result.status >= 300 && result.status < 400
        ? 'redirect'
        : 'http_status';

  const { error: logError } = await hooks.from('webhook_deliveries').insert({
    endpoint_id: endpoint.id,
    workspace_id: endpoint.workspace_id,
    event_id: eventId,
    event_type: 'ping',
    inbox_id: null,
    message_ids: null,
    attempt: 1,
    status: ok ? 'delivered' : 'failed',
    response_code: status,
    error_code: errorCode,
    created_at: createdAt,
    last_attempt_at: new Date().toISOString(),
    delivered_at: ok ? new Date().toISOString() : null,
  });
  if (logError) console.error('[webhook-endpoints] test log insert failed:', logError.code);

  return NextResponse.json({ ok, eventId, status, errorCode });
}
