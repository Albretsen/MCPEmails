import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { checkRateLimit } from '@/lib/rate-limit';
import { encryptToken } from '@/lib/crypto';
import {
  MAX_WEBHOOK_WATCHED_INBOXES,
  PLAN_REQUIRED_BODY,
  coveredInboxCount,
  maskWebhookUrl,
  resolveWebhookAccess,
  validateInboxIds,
} from '@/lib/webhooks/access';
import { ENDPOINT_PUBLIC_COLUMNS, MAX_WEBHOOK_ENDPOINTS, endpointJson } from '@/lib/webhooks/endpoints';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import { validateWebhookUrl } from '@/lib/webhooks/url';

/**
 * GET  /api/webhook-endpoints   the active workspace's endpoints (any member)
 * POST /api/webhook-endpoints   create one (owner/admin, Pro or Business)
 *
 * Webhooks deliver `message.received` when the new-mail watcher sees mail
 * arrive in an inbox (supabase/functions/client-api/webhooks). See migration
 * 20261024230000 for what is stored.
 *
 * POST body: { url, inboxIds?: string[] | null, payloadMode?: 'ids' | 'headers' }
 *
 * The signing secret is generated here, stored encrypted under ENCRYPTION_KEY,
 * and returned ONCE in the 201 response, like an API key. It is never logged
 * and cannot be read back.
 *
 * Reads go through the user client, so RLS and the column grant (no secret
 * column) apply. The insert goes through the service role, after the role,
 * plan, count and URL checks: browser sessions hold no write grant.
 */

export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const access = await resolveWebhookAccess(supabase, { manage: false });
  if (!access.ok) return NextResponse.json(access.body, { status: access.status });

  // Service role, scoped to the membership-checked workspace: browser
  // sessions hold no grant on `url` (a path can carry the receiver's token),
  // so owners and admins get it whole here and everyone else masked.
  const service = createServiceRoleClient();
  const [{ data, error }, { data: inboxes }] = await Promise.all([
    service
      .from('webhook_endpoints')
      .select(ENDPOINT_PUBLIC_COLUMNS)
      .eq('workspace_id', access.workspaceId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(50),
    service
      .from('inboxes')
      .select('id')
      .eq('workspace_id', access.workspaceId)
      .is('deleted_at', null)
      .eq('status', 'active'),
  ]);
  if (error) {
    console.error('[webhook-endpoints] list failed:', error.code);
    return NextResponse.json({ error: 'Could not load webhooks.' }, { status: 500 });
  }
  const rows = data ?? [];
  return NextResponse.json({
    endpoints: rows.map((row) => {
      const json = endpointJson(row);
      return access.canManage ? json : { ...json, url: maskWebhookUrl(json.url) };
    }),
    webhooksEnabled: access.webhooksEnabled,
    plan: access.plan,
    canManage: access.canManage,
    maxEndpoints: MAX_WEBHOOK_ENDPOINTS,
    maxWatchedInboxes: MAX_WEBHOOK_WATCHED_INBOXES,
    coveredInboxes: coveredInboxCount((inboxes ?? []).map((i) => i.id), rows),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const access = await resolveWebhookAccess(supabase, { manage: true });
  if (!access.ok) return NextResponse.json(access.body, { status: access.status });
  if (!access.webhooksEnabled) return NextResponse.json(PLAN_REQUIRED_BODY, { status: 403 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }
  const { url, inboxIds, payloadMode } = body as { url?: unknown; inboxIds?: unknown; payloadMode?: unknown };

  const mode = payloadMode === undefined ? 'ids' : payloadMode;
  if (mode !== 'ids' && mode !== 'headers') {
    return NextResponse.json({ error: 'payloadMode must be "ids" or "headers".' }, { status: 400 });
  }

  if (await checkRateLimit(`webhooks:create:${access.workspaceId}`, 20, 3_600_000)) {
    return NextResponse.json({ error: 'Too many webhook changes. Try again in an hour.' }, { status: 429 });
  }

  const service = createServiceRoleClient();
  const hooks = service;

  const { count, error: countError } = await hooks
    .from('webhook_endpoints')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', access.workspaceId);
  if (countError) return NextResponse.json({ error: 'Could not create the webhook.' }, { status: 500 });
  if ((count ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
    return NextResponse.json(
      { error: `A workspace can have ${MAX_WEBHOOK_ENDPOINTS} webhooks. Delete one first.`, error_code: 'endpoint_limit' },
      { status: 409 },
    );
  }

  const verdict = await validateWebhookUrl(url);
  if (!verdict.ok) return NextResponse.json({ error: verdict.message, error_code: verdict.code }, { status: 400 });

  const inboxes = await validateInboxIds(service, access.workspaceId, inboxIds);
  if (!inboxes.ok) return NextResponse.json({ error: inboxes.error, error_code: inboxes.code }, { status: 400 });

  // The plaintext exists in this function and in the response only.
  const { secret, prefix } = generateWebhookSecret();
  let ciphertext: string;
  try {
    ciphertext = encryptToken(secret);
  } catch {
    console.error('[webhook-endpoints] ENCRYPTION_KEY is not usable.');
    return NextResponse.json({ error: 'Could not create the webhook.' }, { status: 500 });
  }

  const { data: row, error } = await hooks
    .from('webhook_endpoints')
    .insert({
      workspace_id: access.workspaceId,
      url: verdict.url.href,
      secret_ciphertext: ciphertext,
      secret_prefix: prefix,
      inbox_ids: inboxes.value,
      payload_mode: mode,
      created_by: access.userId,
    })
    .select(ENDPOINT_PUBLIC_COLUMNS)
    .single();
  // The trigger webhook_endpoints_limit re-counts under a per-workspace lock,
  // so two concurrent creates cannot both pass the check above.
  if (error && /webhook_endpoint_limit/.test(error.message ?? '')) {
    return NextResponse.json(
      { error: `A workspace can have ${MAX_WEBHOOK_ENDPOINTS} webhooks. Delete one first.`, error_code: 'endpoint_limit' },
      { status: 409 },
    );
  }
  if (error || !row) {
    console.error('[webhook-endpoints] insert failed:', error?.code);
    return NextResponse.json({ error: 'Could not create the webhook.' }, { status: 500 });
  }

  return NextResponse.json({ ...endpointJson(row), secret }, { status: 201 });
}
