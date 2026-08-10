import type { NextRequest } from 'next/server';

/**
 * Same-origin guard for state-changing requests.
 *
 * The approvals review page is opened from a link that lives inside an AI
 * conversation, so its endpoints are unusually exposed to being fetched by
 * something that is not the user: a link-preview bot, a scanner, another site.
 * Three independent things stop a cross-site request from deciding a send:
 *
 *   1. The decision is POST-only. There is no GET side effect anywhere on this
 *      path — merely fetching a URL can never send an email.
 *   2. `Content-Type: application/json` is required. An HTML <form> can only
 *      emit urlencoded / multipart / text-plain, so it cannot forge this
 *      request without a preflight the browser will block.
 *   3. `Origin` must match the host being served (this function).
 *
 * On top of those, the decision endpoint requires a single-use CSRF token
 * bound to the signed-in user.
 *
 * A missing `Origin` header is treated as a failure. Browsers always send it
 * on cross-origin and same-origin non-GET fetches, so absence means the caller
 * is not a browser doing what we support.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const candidates = new Set<string>();
  const host = request.headers.get('host');
  if (host) candidates.add(host);
  try {
    candidates.add(new URL(request.url).host);
  } catch {
    /* non-absolute URL: ignore */
  }
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) {
    try {
      candidates.add(new URL(configured).host);
    } catch {
      /* misconfigured env: ignore */
    }
  }

  return candidates.has(originHost);
}

/** True when the request body is JSON (blocks cross-origin HTML form posts). */
export function isJsonRequest(request: NextRequest): boolean {
  const contentType = request.headers.get('content-type') ?? '';
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}
