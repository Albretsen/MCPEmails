/**
 * GET /api/support/preview: lets staff see the SIGNED-OUT /help form.
 *
 *   signed-in internal user      sets the preview cookie, 303 to /help
 *   ?clear=1, visible caller     clears the cookie, 303 to /help
 *   anyone else, any method      the unmatched-path 404
 *
 * Minting needs a real internal SESSION, not merely a valid preview cookie,
 * so a preview token can never be used to mint a fresh one and outlive its
 * 30 days. The cookie is not HttpOnly on purpose: it is signed, and the
 * client-side footer and error-page helper only check that it is present
 * before asking /api/support/visibility.
 *
 * The whole route goes at release. // SUPPORT_RELEASE_GATE
 */
import { isInternalAccount } from '@/lib/analytics/internal-accounts';
import { supportMethodNotAllowed, supportNotFound } from '@/lib/support/http';
import {
  mintSupportPreviewToken,
  SUPPORT_PREVIEW_COOKIE,
  SUPPORT_PREVIEW_TTL_MS,
} from '@/lib/support/release-gate'; // SUPPORT_RELEASE_GATE
import { getSupportViewer } from '@/lib/support/viewer';

function redirectToHelp(request: Request, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: new URL('/help', request.url).toString(),
      'Set-Cookie': cookie,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE

  const clear = new URL(request.url).searchParams.get('clear') === '1';
  if (clear) {
    return redirectToHelp(request, `${SUPPORT_PREVIEW_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
  }

  if (!viewer.user || !isInternalAccount(viewer.user.email)) return supportNotFound(); // SUPPORT_RELEASE_GATE

  let token: string;
  try {
    token = mintSupportPreviewToken(viewer.user.email);
  } catch {
    // CSRF_SECRET unusable: there is nothing safe to mint.
    return supportNotFound();
  }
  const maxAge = Math.floor(SUPPORT_PREVIEW_TTL_MS / 1000);
  return redirectToHelp(request, `${SUPPORT_PREVIEW_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Lax`);
}

async function otherMethod(): Promise<Response> {
  const viewer = await getSupportViewer();
  if (!viewer.visible) return supportNotFound(); // SUPPORT_RELEASE_GATE
  return supportMethodNotAllowed('GET');
}

export const HEAD = otherMethod;
export const POST = otherMethod;
export const PUT = otherMethod;
export const PATCH = otherMethod;
export const DELETE = otherMethod;
export const OPTIONS = otherMethod;
