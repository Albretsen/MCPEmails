import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/** Shape of a single activity_log row returned by the Supabase select. */
interface ActivityLogRow {
  id: string;
  tool_name: string;
  status: string;
  error_code: string | null;
  duration_ms: number | null;
  created_at: string;
  inboxes: { email_address: string; display_name: string | null } | null;
  api_keys: { name: string; key_prefix: string } | null;
}

/**
 * GET /api/security/audit-log?page=0&pageSize=25
 *
 * Returns a paginated slice of activity_log rows for the authenticated user's
 * workspace, joined with the related inbox and api_key display fields.
 *
 * Query parameters:
 *   page     : zero-based page index (default: 0)
 *   pageSize : rows per page, capped at 100 (default: 25)
 *
 * Response shape:
 *   {
 *     entries: AuditEntry[];
 *     total: number;
 *     page: number;
 *     pageSize: number;
 *   }
 *
 * AuditEntry fields:
 *   id, tool, inbox, apiKeyName, apiKeyPrefix, status, errorCode, durationMs, createdAt
 *
 * Security:
 *   - Requires a valid Supabase session cookie (dashboard auth).
 *   - RLS on activity_log enforces workspace isolation; this route also
 *     explicitly resolves the workspace from workspace_members for defence-in-depth.
 *   - Never returns encrypted credential columns from inboxes or api_keys.
 */

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Resolve workspace.
  const { data: member, error: memberError } = await supabase
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', user.id)
    .single();

  if (memberError || !member) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  const workspaceId = member.workspace_id;

  // 3. Parse and validate query params.
  const url = new URL(request.url);
  const rawPage = parseInt(url.searchParams.get('page') ?? '0', 10);
  const rawPageSize = parseInt(
    url.searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE),
    10,
  );

  const page = isNaN(rawPage) || rawPage < 0 ? 0 : rawPage;
  const pageSize =
    isNaN(rawPageSize) || rawPageSize < 1
      ? DEFAULT_PAGE_SIZE
      : Math.min(rawPageSize, MAX_PAGE_SIZE);

  const from = page * pageSize;
  const to = from + pageSize - 1;

  // 4. Fetch total count (no data, just the count header).
  const { count: totalCount, error: countError } = await supabase
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);

  if (countError) {
    console.error('[audit-log] count query failed:', countError.message);
    return NextResponse.json({ error: 'Failed to fetch audit log.' }, { status: 500 });
  }

  // 5. Fetch the requested page of rows with joined display fields.
  const { data: rows, error: rowsError } = await supabase
    .from('activity_log')
    .select(
      'id, tool_name, status, error_code, duration_ms, created_at, inboxes(email_address, display_name), api_keys(name, key_prefix)',
    )
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (rowsError) {
    console.error('[audit-log] rows query failed:', rowsError.message);
    return NextResponse.json({ error: 'Failed to fetch audit log.' }, { status: 500 });
  }

  // 6. Shape the response: no secrets, no raw credentials.
  const entries = ((rows ?? []) as ActivityLogRow[]).map((row) => {
    const inboxRel = row.inboxes;
    const keyRel = row.api_keys;

    return {
      id: row.id,
      tool: row.tool_name,
      inbox: inboxRel?.display_name ?? inboxRel?.email_address ?? null,
      apiKeyName: keyRel?.name ?? null,
      apiKeyPrefix: keyRel?.key_prefix ?? null,
      status: row.status,
      errorCode: row.error_code ?? null,
      durationMs: row.duration_ms ?? null,
      createdAt: row.created_at,
    };
  });

  return NextResponse.json({
    entries,
    total: totalCount ?? 0,
    page,
    pageSize,
  });
}
