/**
 * GET /api/support/visibility: 204 when Help & support is visible to this
 * visitor, the unmatched-path 404 otherwise.
 *
 * For client-only contexts (error pages, marketing footer) that cannot call
 * the gate on the server. Whole route goes at release. // SUPPORT_RELEASE_GATE
 */
import { supportMethodNotAllowed, supportNotFound } from '@/lib/support/http';
import { getSupportViewer } from '@/lib/support/viewer';

export async function GET(): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export const HEAD = GET;

async function otherMethod(): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE
  return supportMethodNotAllowed('GET, HEAD');
}

export const POST = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
