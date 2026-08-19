import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { isJsonRequest, isSameOrigin } from '@/lib/http/same-origin';
import { canDecide as canManageAutomations } from '@/lib/approvals/decide';
import { assertWorkspaceResources, isUuid, validateFilter } from '@/lib/automations/rules';

/**
 * POST /api/automations/preview
 *
 * A dry run: what does this filter match in the mailbox RIGHT NOW?
 *
 * This is the trust affordance the whole feature rests on. An automation is the
 * first thing the product does to a mailbox with nobody watching, so the user
 * has to be able to see the blast radius BEFORE enabling anything. Preview is
 * therefore strictly read-only: it runs the same normalized search the runner
 * would run, returns metadata for the messages it found, and touches nothing.
 * It writes no run row, claims no dedupe ledger entry, and takes no lease.
 *
 * WHY THIS PROXIES THE EDGE FUNCTION
 * ----------------------------------
 * Only the Edge Function can talk to a mailbox: it holds the IMAP/Graph clients
 * and the decryption path for stored credentials. This route is the
 * authenticated, workspace-scoped front door to that capability. It does the
 * authorization the Edge Function cannot do (browser session, active workspace,
 * role, resource ownership) and forwards a request that is already known-good.
 *
 * Nothing about a preview is persisted, and the message metadata it returns is
 * passed straight back to the caller's browser without being written anywhere,
 * which keeps the fetch-live-never-store promise intact.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

/**
 * The Edge Function route that performs the live search. It is part of the same
 * mcp-server function as /triage-dispatch and is authorized with the service
 * role key, which only this server-side route holds.
 */
const PREVIEW_ENDPOINT = `${SUPABASE_URL}/functions/v1/mcp-server/triage-preview`;

/**
 * A preview is a person waiting in front of a modal, not a background job. A
 * mailbox search can legitimately run long, but past roughly a minute the
 * honest answer is "that took too long" rather than a spinner that never ends.
 */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** How many matches a preview shows. Enough to judge a filter, small enough to stay readable. */
const PREVIEW_LIMIT = 25;

export const maxDuration = 90;

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

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request) || !isJsonRequest(request)) {
    return NextResponse.json({ error: 'Bad request.' }, { status: 403 });
  }
  const c = await context();
  if (!c) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  // Same gate as creating a rule. Preview reads a mailbox on demand, so it is
  // not a free action to hand to every viewer, and only owners and admins can
  // act on what it shows anyway.
  if (!canManageAutomations(c.role)) {
    return NextResponse.json({ error: 'Only workspace owners and admins can preview automations.' }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'A request body is required.' }, { status: 400 });

  const filter = validateFilter(body.filter);
  if (!filter.ok) return NextResponse.json({ error: filter.error }, { status: 400 });

  if (!isUuid(body.inbox_id)) return NextResponse.json({ error: 'Choose the inbox this automation runs against.' }, { status: 400 });
  if (!isUuid(body.api_key_id)) return NextResponse.json({ error: 'Choose the API key this automation acts with.' }, { status: 400 });

  const ownership = await assertWorkspaceResources(c.db, c.workspaceId, body.inbox_id, body.api_key_id);
  if (ownership) return NextResponse.json({ error: ownership.error }, { status: ownership.status });

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceRoleKey) {
    return NextResponse.json({ error: 'Preview is not available right now.' }, { status: 503 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(PREVIEW_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        workspace_id: c.workspaceId,
        inbox_id: body.inbox_id,
        api_key_id: body.api_key_id,
        filter: filter.value,
        limit: PREVIEW_LIMIT,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // Deliberately no error body in the log: the request carries the service
    // role key and a search term the user typed.
    console.error('[api/automations/preview] upstream request failed');
    return NextResponse.json({ error: 'The mailbox did not answer in time. Try the preview again in a moment.' }, { status: 504 });
  }

  const payload = await upstream.json().catch(() => null);

  if (!upstream.ok || !payload || typeof payload !== 'object') {
    // A 404 here means the Edge Function does not expose the preview route yet.
    // Saying so plainly beats a generic failure that reads like a broken filter.
    if (upstream.status === 404) {
      return NextResponse.json({ error: 'Preview is not available on this server yet.' }, { status: 503 });
    }
    const upstreamError = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : 'Could not preview this filter against the mailbox.';
    return NextResponse.json({ error: upstreamError }, { status: upstream.status >= 400 && upstream.status < 500 ? 400 : 502 });
  }

  const source = payload as { matched?: unknown; truncated?: unknown; messages?: unknown };
  const messages = Array.isArray(source.messages) ? source.messages : [];

  // Re-projected rather than forwarded wholesale. The Edge Function is trusted,
  // but a preview response is the one place mailbox content flows through this
  // app, and an explicit field list means a future upstream change cannot widen
  // what reaches the browser without someone editing this line.
  return NextResponse.json({
    matched: typeof source.matched === 'number' ? source.matched : messages.length,
    truncated: source.truncated === true,
    limit: PREVIEW_LIMIT,
    messages: messages.slice(0, PREVIEW_LIMIT).map((message) => {
      const row = (message ?? {}) as Record<string, unknown>;
      return {
        id: typeof row.id === 'string' ? row.id : null,
        subject: typeof row.subject === 'string' ? row.subject : '',
        from: typeof row.from === 'string' ? row.from : '',
        date: typeof row.date === 'string' ? row.date : null,
        unread: row.unread === true,
      };
    }),
  });
}
