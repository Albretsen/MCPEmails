import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';

/**
 * PATCH /api/api-keys/[id]
 *
 * Updates an existing key's granted scopes and inbox access without requiring
 * the user to reconnect their MCP client. This is the dashboard equivalent of
 * re-running the OAuth consent flow: it lets the user broaden or narrow what an
 * already-issued connection can do.
 *
 * Body (JSON):
 *   scopes:    string[]              — at least one valid scope (see VALID_SCOPES)
 *   inboxIds:  string[] | null       — null = ALL inboxes (including future ones);
 *                                      a non-empty UUID array = explicit allowlist.
 *                                      An empty array is rejected (it is ambiguous
 *                                      and the MCP server treats it inconsistently).
 *
 * Steps:
 *   1. Authenticate the requesting user.
 *   2. Validate scopes (and the viewer-role restriction).
 *   3. Resolve the active workspace and the caller's role.
 *   4. Validate inboxIds belong to this workspace (when an explicit list is given).
 *   5. Update the api_keys row (service role, scoped to id + workspace_id, not deleted).
 *   6. Sync any linked oauth_refresh_tokens rows so the change is durable across
 *      OAuth token refreshes — otherwise a refresh would keep propagating the old
 *      scopes/inboxes carried on the refresh-token chain.
 *
 * Enforcement note: the MCP server treats inbox_ids === null as "all inboxes" and
 * a non-empty array as an allowlist. An empty array is never stored here.
 *
 * References:
 *   Documents/Architecture/api-key-management.md §4 (lifecycle)
 */

// Must match the scopes the MCP server enforces and the OAuth authorize flow's
// VALID_SCOPES. Kept in sync with app/api/api-keys/route.ts. search:email is
// vestigial (read:email already covers search) but retained for parity and
// backward compatibility.
const VALID_SCOPES = [
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
] as const;

/** Scopes available to workspace viewers (read-only). */
const VIEWER_SCOPES = new Set(['read:email', 'search:email']);

type Scope = (typeof VALID_SCOPES)[number];

function isValidScope(s: unknown): s is Scope {
  return typeof s === 'string' && (VALID_SCOPES as readonly string[]).includes(s);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: keyId } = await params;

  if (!keyId || typeof keyId !== 'string' || keyId.length > 100) {
    return NextResponse.json({ error: 'Invalid key ID.' }, { status: 400 });
  }

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

  const { scopes, inboxIds } = body as { scopes?: unknown; inboxIds?: unknown };

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
    if (!sanitizedScopes.includes(s)) sanitizedScopes.push(s);
  }

  // inboxIds: null (or omitted) = all inboxes; otherwise a non-empty UUID array.
  let sanitizedInboxIds: string[] | null;
  if (inboxIds === null || inboxIds === undefined) {
    sanitizedInboxIds = null; // all inboxes, including ones connected later
  } else if (Array.isArray(inboxIds)) {
    if (inboxIds.length === 0) {
      return NextResponse.json(
        {
          error:
            'Select at least one inbox, or choose "all inboxes". An empty selection is not allowed.',
        },
        { status: 400 },
      );
    }
    const ids: string[] = [];
    for (const id of inboxIds) {
      if (typeof id !== 'string' || id.length === 0 || id.length > 100) {
        return NextResponse.json({ error: 'Invalid inbox ID in selection.' }, { status: 400 });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    sanitizedInboxIds = ids;
  } else {
    return NextResponse.json(
      { error: 'inboxIds must be an array of inbox IDs or null for all inboxes.' },
      { status: 400 },
    );
  }

  // 3. Resolve the active workspace (cookie-aware) and the caller's role in it.
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (memberError || !member) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // Viewers may only grant read-only scopes.
  if (member.role === 'viewer') {
    const disallowedScope = sanitizedScopes.find((s) => !VIEWER_SCOPES.has(s));
    if (disallowedScope) {
      return NextResponse.json(
        {
          error: `Workspace viewers cannot grant the '${disallowedScope}' scope. Allowed scopes for viewers: ${[...VIEWER_SCOPES].join(', ')}.`,
          error_code: 'insufficient_role',
        },
        { status: 403 },
      );
    }
  }

  const service = createServiceRoleClient();

  // 4. When an explicit inbox allowlist is given, verify every id belongs to
  //    this workspace and is not deleted. This prevents granting access to
  //    inboxes outside the workspace by injecting arbitrary UUIDs.
  if (sanitizedInboxIds !== null) {
    const { data: ownedRows, error: inboxError } = await service
      .from('inboxes')
      .select('id')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .in('id', sanitizedInboxIds);

    if (inboxError) {
      console.error('[update-api-key] Inbox ownership check failed:', inboxError.message);
      return NextResponse.json({ error: 'Failed to validate inbox selection.' }, { status: 500 });
    }

    const ownedIds = new Set((ownedRows ?? []).map((r) => r.id));
    const foreign = sanitizedInboxIds.find((id) => !ownedIds.has(id));
    if (foreign) {
      return NextResponse.json(
        { error: 'One or more selected inboxes do not belong to this workspace.' },
        { status: 400 },
      );
    }
  }

  // 5. Update the key. Scoped to id + workspace_id; the deleted_at guard means a
  //    revoked connection cannot be silently re-activated by editing it.
  const { data: updated, error: updateError } = await service
    .from('api_keys')
    .update({ scopes: sanitizedScopes, inbox_ids: sanitizedInboxIds })
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .select('id, name, key_prefix, scopes, inbox_ids, created_at, last_used_at, expires_at');

  if (updateError) {
    console.error('[update-api-key] Update failed:', updateError.message);
    return NextResponse.json({ error: 'Failed to update API key.' }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'API key not found.' }, { status: 404 });
  }

  // 6. Keep OAuth refresh-token chains in sync. The access token (api_keys row)
  //    is the source of truth the MCP server enforces, but a refresh propagates
  //    the scopes/inboxes stored on the refresh-token row. Without this sync, a
  //    refresh would still reflect the old grant in its scope response and the
  //    legacy key-recreation path would reintroduce the old values.
  const { error: rtSyncError } = await service
    .from('oauth_refresh_tokens')
    .update({ scopes: sanitizedScopes, inbox_ids: sanitizedInboxIds })
    .eq('api_key_id', keyId)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null);

  if (rtSyncError) {
    // Non-fatal: the api_keys row (what the MCP server enforces) is already
    // updated. Log and continue so the user sees their change applied.
    console.warn('[update-api-key] Refresh-token sync failed:', rtSyncError.message);
  }

  const row = updated[0];
  return NextResponse.json({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    inboxIds: row.inbox_ids ?? null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
  });
}
