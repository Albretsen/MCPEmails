import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { RUN_COLUMNS, RUN_ITEM_COLUMNS, isUuid } from '@/lib/automations/rules';

/**
 * GET /api/automations/[id]/runs
 *
 * The run log for one automation: the record of what an unattended rule did to
 * a mailbox. This is the accountability surface for the whole feature, so it is
 * readable by every workspace member, not just the owners and admins who can
 * change a rule. Seeing what happened and being allowed to change it are
 * different privileges.
 *
 * Two shapes, one route:
 *
 *   ?limit=&before=   a page of runs, newest first, keyset-paginated on
 *                     started_at. Offset pagination would skip or repeat rows
 *                     as new runs land mid-scroll, and a run log grows from the
 *                     top continuously.
 *   ?run_id=          one run plus its per-message items.
 *
 * Read-only by design. There is no POST here: a manual "run now" belongs to the
 * runner in the Edge Function, which owns the lease and the dedupe ledger. A
 * second writer of run rows would be a second way to violate the invariant that
 * a rule has at most one run in flight.
 */

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const workspaceId = await resolveActiveWorkspaceId(auth, user.id);
  if (!workspaceId) return null;
  // The triage_automations migration has not been regenerated into Database yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createServiceRoleClient() as any;
  const { data: membership } = await db.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  return membership ? { user, workspaceId, role: membership.role, db } : null;
}

/** Page size. Bounded well under the silent 1000-row PostgREST truncation. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Items shown for a single run. The per-run message cap is 200
 * (triage_rules.max_messages_per_run), so this returns every item a run can
 * ever produce and the modal never needs a second page.
 */
const MAX_ITEMS = 200;

function parseLimit(raw: string | null): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: 'That automation could not be found.' }, { status: 404 });

  // Resolve the rule through the workspace first. Every query below is then
  // scoped by both rule_id and workspace_id, so a run id belonging to another
  // tenant cannot be read by pairing it with a rule id from this one.
  //
  // Soft-deleted rules are deliberately still readable here: the run history is
  // the reason the delete is soft, and a user's first question after switching
  // an automation off is what it already did.
  const { data: rule } = await c.db.from('triage_rules')
    .select('id, name, enabled, deleted_at, inbox_id, inboxes(email_address, display_name)')
    .eq('id', id)
    .eq('workspace_id', c.workspaceId)
    .maybeSingle();
  if (!rule) return NextResponse.json({ error: 'That automation could not be found.' }, { status: 404 });

  const runId = request.nextUrl.searchParams.get('run_id');

  if (runId) {
    if (!isUuid(runId)) return NextResponse.json({ error: 'That run could not be found.' }, { status: 404 });

    const { data: run } = await c.db.from('triage_runs')
      .select(RUN_COLUMNS)
      .eq('id', runId)
      .eq('rule_id', id)
      .eq('workspace_id', c.workspaceId)
      .maybeSingle();
    if (!run) return NextResponse.json({ error: 'That run could not be found.' }, { status: 404 });

    // RUN_ITEM_COLUMNS deliberately omits message_digest and undo_state. The
    // digest is an opaque internal correlation key with no meaning to a reader,
    // and undo_state is ciphertext holding provider message ids. Neither
    // belongs in a browser response.
    const { data: items, error: itemsError } = await c.db.from('triage_run_items')
      .select(RUN_ITEM_COLUMNS)
      .eq('run_id', runId)
      .eq('rule_id', id)
      .order('created_at', { ascending: true })
      .limit(MAX_ITEMS);
    if (itemsError) return NextResponse.json({ error: 'Failed to load this run.' }, { status: 500 });

    return NextResponse.json({
      rule: { id: rule.id, name: rule.name, deleted: Boolean(rule.deleted_at), inbox: rule.inboxes ?? null },
      run,
      items: items ?? [],
    });
  }

  const limit = parseLimit(request.nextUrl.searchParams.get('limit'));
  const before = request.nextUrl.searchParams.get('before');
  if (before && Number.isNaN(Date.parse(before))) {
    return NextResponse.json({ error: 'The pagination cursor is not a valid timestamp.' }, { status: 400 });
  }

  // One row over the page size, so the client learns there is more without a
  // second count query. The extra row is trimmed off before it is returned.
  let query = c.db.from('triage_runs')
    .select(RUN_COLUMNS)
    .eq('rule_id', id)
    .eq('workspace_id', c.workspaceId)
    .order('started_at', { ascending: false })
    .limit(limit + 1);
  if (before) query = query.lt('started_at', before);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load run history.' }, { status: 500 });

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const runs = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    rule: { id: rule.id, name: rule.name, deleted: Boolean(rule.deleted_at), inbox: rule.inboxes ?? null },
    runs,
    has_more: hasMore,
    next_before: hasMore ? (runs[runs.length - 1]?.started_at ?? null) : null,
  });
}
