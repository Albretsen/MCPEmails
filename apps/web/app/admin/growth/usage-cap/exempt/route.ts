import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { requireAdmin } from '@/lib/admin/require-admin';
import { GROWTH_TAGS } from '@/lib/analytics/growth-queries';
import { createServiceRoleClient } from '@/lib/supabase/service';

/**
 * POST /admin/growth/usage-cap/exempt
 *
 * The form target for "grant an exemption" on /admin/growth/usage-cap. A
 * plain route handler rather than a Server Action, for the reason every
 * handler under /admin/growth gives: the action-ID lookup failed on every
 * submission in production (verified 2026-08-30).
 *
 * THE SAME WRITE AS /api/admin/usage-exemptions, deliberately. That route
 * takes JSON and answers JSON, which a form without JavaScript cannot speak,
 * and its helpers are not exported, so the validation is reproduced here
 * with the same limits: reason 1..500, ticket 1..200, workspace_id a uuid,
 * expires_at either absent or a valid instant. One addition: a date in the
 * past is refused here rather than by the table's CHECK
 * (workspace_usage_exemptions_expiry_after_grant), so the operator reads
 * "must be in the future" instead of a constraint name.
 *
 * The form sends a bare date; it is read as 00:00 UTC on that day, which is
 * what the page says next to the field.
 */

const PAGE = '/admin/growth/usage-cap';
const MAX_REASON_LENGTH = 500;
const MAX_TICKET_LENGTH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(form: FormData, field: string, max: number): string | null {
  const value = form.get(field);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** A bare YYYY-MM-DD becomes midnight UTC; anything else must parse as is. */
function expiry(raw: string | null): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!raw) return { ok: true, value: null };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return { ok: false, message: 'The end date could not be read.' };
  if (parsed.getTime() <= Date.now()) return { ok: false, message: 'The end date must be in the future.' };
  return { ok: true, value: parsed.toISOString() };
}

function back(request: NextRequest, query: string): NextResponse {
  return NextResponse.redirect(new URL(`${PAGE}?${query}`, request.url), { status: 303 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const admin = await requireAdmin();
  const form = await request.formData().catch(() => null);
  if (!form) return back(request, 'error=' + encodeURIComponent('The form could not be read.'));

  const workspaceId = text(form, 'workspace_id', 36);
  const reason = text(form, 'reason', MAX_REASON_LENGTH);
  const ticketId = text(form, 'ticket_id', MAX_TICKET_LENGTH);
  const until = expiry(text(form, 'expires_at', 64));

  if (!workspaceId || !UUID.test(workspaceId) || !reason || !ticketId) {
    const query = new URLSearchParams({
      error: 'A workspace uuid, a reason (up to 500 characters) and a ticket id (up to 200) are all required.',
    });
    if (workspaceId) query.set('workspace_id', workspaceId);
    return back(request, `${query.toString()}#exempt`);
  }
  if (!until.ok) {
    return back(request, `${new URLSearchParams({ error: until.message, workspace_id: workspaceId }).toString()}#exempt`);
  }

  const { error } = await createServiceRoleClient()
    .from('workspace_usage_exemptions')
    .insert({ workspace_id: workspaceId, reason, ticket_id: ticketId, granted_by: admin.id, expires_at: until.value })
    .select('id')
    .single();

  if (error) {
    // The raw message, because this page is operator-only and a foreign-key
    // failure on the workspace id is the likeliest cause and worth reading.
    return back(request, `${new URLSearchParams({ error: `Could not create the exemption: ${error.message}`, workspace_id: workspaceId }).toString()}#exempt`);
  }

  // The band and this page read the same cached roster; the workspace just
  // exempted must leave it on the next render, not ten minutes from now.
  revalidateTag(GROWTH_TAGS.usageCap, { expire: 0 });

  const ok = until.value ? `exemption for ${workspaceId.slice(0, 8)} until ${until.value.slice(0, 10)}` : `open-ended exemption for ${workspaceId.slice(0, 8)}`;
  return back(request, new URLSearchParams({ ok }).toString());
}
