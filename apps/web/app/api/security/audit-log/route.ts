import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { canManageWorkspace, fetchWorkspaceRole } from '@/lib/workspace/roles';
import {
  auditCsvStream,
  fetchAuditCallsPage,
  fetchAuditEventsPage,
  parseAuditDate,
  parseAuditPaging,
  type AuditFilters,
  type AuditSource,
} from '@/lib/security/audit-log';

/**
 * GET /api/security/audit-log
 *
 * The Security page's audit log for the caller's active workspace.
 *
 * Query parameters:
 *   source    'calls' (default): MCP tool calls, public.activity_log
 *             'events': team changes, public.workspace_audit_events
 *   page      zero-based page index (default 0)
 *   pageSize  rows per page, capped at 100 (default 25)
 *   since     ISO date or timestamp, inclusive (optional)
 *   until     ISO date or timestamp, exclusive (optional)
 *   format    'json' (default) or 'csv'
 *
 * JSON: { entries, total, page, pageSize } for calls,
 *       { events, total, page, pageSize } for events.
 * CSV:  streamed, the same source and date filters, newest first, at most
 *       50,000 rows (src/lib/security/audit-log.ts), formula-injection safe.
 *
 * Who sees what (src/lib/security/audit-log.ts):
 *   member        calls on inboxes they can see (RLS), no events, no CSV (403)
 *   owner, admin  every call (service role, metadata only), events, CSV
 *
 * Every entry names the person who acted (activity_log.user_id,
 * workspace_audit_events.actor_user_id) by email and name. Never message
 * content, never credential columns.
 *
 * DELIBERATELY NOT bounded by the analytics retention window that
 * src/lib/analytics/retention.ts applies to the Usage page. An audit log is a
 * security artifact, not a usage metric; what it can show is bounded by
 * storage (the per-plan purge keeps every mailbox-changing call and every team
 * change at least 90 days), not by this query.
 *
 * GET is the only exported method; any other is 405 from Next.js.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const supabase = await createClient();

  // 1. Authenticate.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Resolve workspace (cookie-aware; multi-workspace safe).
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }

  // 3. Parse query.
  const url = new URL(request.url);
  const rawSource = url.searchParams.get('source') ?? 'calls';
  if (rawSource !== 'calls' && rawSource !== 'events') {
    return NextResponse.json({ error: "source must be 'calls' or 'events'." }, { status: 400 });
  }
  const source: AuditSource = rawSource;
  const format = url.searchParams.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv') {
    return NextResponse.json({ error: "format must be 'json' or 'csv'." }, { status: 400 });
  }
  const rawSince = url.searchParams.get('since');
  const rawUntil = url.searchParams.get('until');
  const filters: AuditFilters = { since: parseAuditDate(rawSince), until: parseAuditDate(rawUntil) };
  if ((rawSince && !filters.since) || (rawUntil && !filters.until)) {
    return NextResponse.json({ error: 'since and until must be dates.' }, { status: 400 });
  }
  const { page, pageSize } = parseAuditPaging(url);

  // 4. Role. Owners and admins read every row with the service role (an
  //    audit row is metadata, and an audit log with holes in it is no audit
  //    log); a member reads through RLS, which hides calls on other people's
  //    private inboxes.
  const role = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!role) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  const manager = canManageWorkspace(role);
  if ((source === 'events' || format === 'csv') && !manager) {
    return NextResponse.json(
      { error: 'Only workspace owners and admins can see team changes and export the audit log.', error_code: 'insufficient_role' },
      { status: 403 },
    );
  }
  const service = createServiceRoleClient();

  // 5. CSV export: streamed, one page of rows in memory at a time.
  if (format === 'csv') {
    const day = new Date().toISOString().slice(0, 10);
    const name = source === 'calls' ? 'tool-calls' : 'team-changes';
    return new Response(auditCsvStream(service, workspaceId, source, filters), {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="mcpemails-audit-${name}-${day}.csv"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // 6. JSON pages.
  if (source === 'events') {
    const result = await fetchAuditEventsPage(service, workspaceId, { page, pageSize, filters });
    if (!result.ok) {
      console.error('[audit-log] events query failed:', result.error);
      return NextResponse.json({ error: 'Failed to fetch audit log.' }, { status: 500 });
    }
    return NextResponse.json({ events: result.events, total: result.total, page, pageSize });
  }

  const reader = manager ? service : supabase;
  const result = await fetchAuditCallsPage(reader, service, workspaceId, {
    page,
    pageSize,
    filters,
    // A member never sees someone else's call that named no inbox.
    memberUserId: manager ? null : user.id,
  });
  if (!result.ok) {
    console.error('[audit-log] calls query failed:', result.error);
    return NextResponse.json({ error: 'Failed to fetch audit log.' }, { status: 500 });
  }
  return NextResponse.json({ entries: result.entries, total: result.total, page, pageSize });
}
