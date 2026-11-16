import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { MAX_BODY_BYTES, parseClientEvents } from '@/lib/analytics/client-events';

/**
 * POST /api/analytics/client-event
 *
 * The beacon behind public/ce.js: script errors, failed script loads, buy and
 * contact clicks, buy clicks that never left the page, and one "page" event per
 * load of a buy-relevant page saying whether the app hydrated. Written to
 * public.client_events (migration 20261113100000).
 *
 * Anonymous by design. Nothing identifying is stored: the session is never
 * read (only whether a Supabase auth cookie is present), the user agent is
 * reduced to a browser family, and every field is masked and capped in
 * src/lib/analytics/client-events.ts. Crawlers and headless browsers are
 * dropped.
 *
 * Always 204, never an error to the page: a beacon must be invisible.
 */
export const dynamic = 'force-dynamic';

function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const noContent = new NextResponse(null, { status: 204 });

  try {
    const text = await request.text();
    if (text.length === 0 || text.length > MAX_BODY_BYTES) return noContent;
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return noContent;
    }

    const rows = parseClientEvents(body, {
      userAgent: request.headers.get('user-agent'),
      signedIn: hasSessionCookie(request),
    });
    if (rows.length === 0) return noContent;

    const { error } = await createServiceRoleClient().from('client_events').insert(rows);
    if (error) console.error('[client-event] insert failed', { error: error.message });
  } catch (err) {
    console.error('[client-event] failed', { error: err instanceof Error ? err.message : String(err) });
  }

  return noContent;
}
