// CORS: an allow-list of exactly two origins, no cookies.
//
// The browser sends `Authorization: Bearer <Supabase access token>`, never a
// cookie, so `Access-Control-Allow-Credentials` is deliberately absent. An
// origin outside the list gets NO `Access-Control-Allow-Origin` header at all:
// the browser then refuses to hand the response to the page, which is the
// enforcement. (CORS is not authentication; the bearer check is.)

export const ALLOWED_ORIGINS: readonly string[] = [
  "https://app.mcpemails.com",
  "http://localhost:5183",
];

const ALLOW_HEADERS = "authorization, content-type, x-workspace-id, x-request-id";
const EXPOSE_HEADERS = "server-timing, x-request-id, retry-after, content-disposition";

export function isAllowedOrigin(origin: string | null): origin is string {
  return origin !== null && ALLOWED_ORIGINS.includes(origin);
}

/** Headers to add to every response for this request's Origin. */
export function corsHeaders(origin: string | null): Record<string, string> {
  // `Vary: Origin` always, so a cache never serves one origin's answer to another.
  if (!isAllowedOrigin(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": EXPOSE_HEADERS,
    Vary: "Origin",
  };
}

/** The answer to an OPTIONS preflight. 204 for an allowed origin, 403 otherwise. */
export function preflightResponse(origin: string | null): Response {
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      // PUT and DELETE are the push routes (push/routes.ts).
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": ALLOW_HEADERS,
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}
