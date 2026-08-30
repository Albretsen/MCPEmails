import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateApiKey } from '@/lib/api-keys/generate';
import { checkApiKeyLimit } from '@/lib/plans/check-api-key-limit';
import { checkRateLimit } from '@/lib/rate-limit';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { getActiveApiKeyNames, isApiKeyNameTaken } from '@/lib/api-keys/unique-name';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
// The scope vocabulary and the viewer allow-list live in one module now: the
// demotion path in workspaces/members/[userId] enforces the same allow-list on
// keys that already exist, and three hand-kept copies is where they drift.
import { VALID_SCOPES, VIEWER_SCOPES, isValidScope, type Scope } from '@/lib/api-keys/scopes';

/**
 * POST /api/api-keys
 *
 * Creates a new MCP API key for the authenticated user's workspace.
 *
 * Steps:
 *   1. Authenticate the requesting user.
 *   2. Validate request body: name (1–128 chars) and scopes (non-empty, valid values).
 *   3. Resolve the user's workspace via workspace_members.
 *   4. Generate a cryptographically secure key (256 bits of CSPRNG entropy).
 *      Format: mcpe_<64 hex chars> (total 69 chars).
 *   5. Hash the raw key with SHA-256. Only the hash is stored in the database.
 *   6. Insert the api_keys row.
 *   7. Return the row data plus rawKey in the 201 response.
 *      rawKey is included ONCE and cannot be retrieved again.
 *
 * Security:
 *   - rawKey is never logged.
 *   - key_hash is never returned in any response.
 *   - After this response is sent, rawKey is unrecoverable. The user must copy
 *     it from the UI before dismissing the reveal dialog.
 *
 * References:
 *   Documents/Architecture/api-key-management.md §1 (format), §4.1 (creation flow)
 */


export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate the requesting user.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Parse and validate request body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { name, scopes, workspaceId: bodyWorkspaceId } = body as {
    name?: unknown;
    scopes?: unknown;
    workspaceId?: unknown;
  };

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (trimmedName.length === 0 || trimmedName.length > 128) {
    return NextResponse.json(
      { error: 'Name is required and must be 1–128 characters.' },
      { status: 400 },
    );
  }

  if (!Array.isArray(scopes) || scopes.length === 0) {
    return NextResponse.json(
      { error: 'At least one scope is required.' },
      { status: 400 },
    );
  }

  const sanitizedScopes: Scope[] = [];
  for (const s of scopes) {
    if (!isValidScope(s)) {
      return NextResponse.json(
        { error: `Unknown scope: ${String(s)}. Valid scopes: ${VALID_SCOPES.join(', ')}.` },
        { status: 400 },
      );
    }
    // Deduplicate
    if (!sanitizedScopes.includes(s)) {
      sanitizedScopes.push(s);
    }
  }

  // 3. Resolve the workspace and the caller's role in it.
  //    If workspaceId is supplied in the body, use it (multi-workspace collaborator case).
  //    Otherwise fall back to the single-member lookup for backwards compatibility.
  let workspaceId: string;
  let callerRole: string;

  if (typeof bodyWorkspaceId === 'string' && bodyWorkspaceId) {
    // Explicit workspace: verify membership and get role in one query.
    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('workspace_id', bodyWorkspaceId)
      .eq('user_id', user.id)
      .single();

    if (memberError || !member) {
      return NextResponse.json({ error: 'Workspace not found or access denied.' }, { status: 403 });
    }
    workspaceId = member.workspace_id;
    callerRole = member.role;
  } else {
    // No explicit workspace: fall back to the caller's active workspace
    // (cookie-aware, multi-workspace safe), then look up their role in it.
    const activeWorkspaceId = await resolveActiveWorkspaceId(supabase, user.id);
    if (!activeWorkspaceId) {
      return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
    }
    const { data: member, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('user_id', user.id)
      .eq('workspace_id', activeWorkspaceId)
      .maybeSingle();

    if (memberError || !member) {
      return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
    }
    workspaceId = member.workspace_id;
    callerRole = member.role;
  }

  // Viewers may only create read-only scoped keys.
  if (callerRole === 'viewer') {
    const disallowedScope = sanitizedScopes.find((s) => !VIEWER_SCOPES.has(s));
    if (disallowedScope) {
      return NextResponse.json(
        {
          error: `Workspace viewers cannot create keys with the '${disallowedScope}' scope. Allowed scopes for viewers: ${[...VIEWER_SCOPES].join(', ')}.`,
          error_code: 'insufficient_role',
        },
        { status: 403 },
      );
    }
  }

  // 3b. Per-workspace rate limit: max 20 creations per hour.
  if (await checkRateLimit(`api-keys:create:${workspaceId}`, 20, 3_600_000)) {
    return NextResponse.json(
      { error: 'Too many API key creations. Try again in an hour.' },
      { status: 429 },
    );
  }

  // 3c. Enforce plan API key cap.
  const keyLimit = await checkApiKeyLimit(supabase, workspaceId);
  if (keyLimit.atLimit) {
    return NextResponse.json(
      {
        error: `Your ${keyLimit.plan} plan allows a maximum of ${keyLimit.maxApiKeys} API key${keyLimit.maxApiKeys === 1 ? '' : 's'}. Revoke an existing key or upgrade your plan.`,
        error_code: 'api_key_limit_reached',
        current_count: keyLimit.currentCount,
        max_api_keys: keyLimit.maxApiKeys,
        upgrade_url: '/pricing',
      },
      { status: 403 },
    );
  }

  // 3d. Reject a duplicate name within the workspace so keys stay
  // distinguishable in the audit log and usage stats. Case-insensitive match
  // against active (non-revoked) keys.
  const existingNames = await getActiveApiKeyNames(supabase, workspaceId);
  if (isApiKeyNameTaken(existingNames, trimmedName)) {
    return NextResponse.json(
      {
        error: `An API key named "${trimmedName}" already exists in this workspace. Choose a distinct name so keys stay distinguishable in the audit log.`,
        error_code: 'duplicate_name',
      },
      { status: 409 },
    );
  }

  // 4–5. Generate the key and hash it.
  // rawKey is a local variable only. It will be included in the response and
  // then fall out of scope. It is never written to disk or any log.
  const { rawKey, keyHash, keyPrefix } = generateApiKey();

  // 6. Insert into database: only keyHash and keyPrefix are persisted, never rawKey.
  const { data: row, error: insertError } = await supabase
    .from('api_keys')
    .insert({
      workspace_id: workspaceId,
      created_by: user.id,
      name: trimmedName,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      scopes: sanitizedScopes,
    })
    .select('id, name, key_prefix, scopes, created_at, last_used_at, expires_at')
    .single();

  if (insertError || !row) {
    // Do not log rawKey or keyHash.
    console.error('[create-api-key] Insert failed:', insertError?.message);
    return NextResponse.json({ error: 'Failed to create API key.' }, { status: 500 });
  }
  await recordProductFunnelEvent(createServiceRoleClient(), { workspaceId, stage: 'credential_created', outcome: 'success', category: 'api_key' });

  // 7. Return the row data plus rawKey ONCE.
  //    The frontend must display this to the user immediately and never request it again.
  return NextResponse.json(
    {
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      scopes: row.scopes,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      expiresAt: row.expires_at ?? null,
      rawKey, // shown once, unrecoverable after this response
    },
    { status: 201 },
  );
}
