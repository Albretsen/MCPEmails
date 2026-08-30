import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin/require-admin';
import { refreshGrowthData } from '@/lib/analytics/growth-queries';

/**
 * POST /admin/growth/refresh
 *
 * Backs the Growth page's Refresh button. A plain route handler rather than a
 * Server Action: see the comment on refreshGrowthData for why.
 *
 * Redirects back to wherever the form was submitted from (the referer),
 * falling back to the page root, so the selected reporting window survives a
 * refresh instead of being reset to the default.
 */
export async function POST(request: Request): Promise<NextResponse> {
  await requireAdmin();
  await refreshGrowthData();
  const referer = request.headers.get('referer');
  const destination = referer && new URL(referer).pathname.startsWith('/admin/growth')
    ? referer
    : new URL('/admin/growth', request.url).toString();
  return NextResponse.redirect(destination, { status: 303 });
}
