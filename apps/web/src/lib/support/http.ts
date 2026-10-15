/**
 * Response helpers shared by the /api/support/* routes.
 *
 * Plain Web `Response`, not NextResponse, so the routes load in a bare
 * `node --test` run (same reasoning as app/api/[[...unmatched]]/route.ts).
 */

/**
 * Byte-for-byte the catch-all's 404 (app/api/[[...unmatched]]/route.ts): to a
 * caller the support API is not there, so a gated route must be
 * indistinguishable from a path that does not exist.
 */
export function supportNotFound(): Response {
  return Response.json({ error: 'Not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export function supportMethodNotAllowed(allow: string): Response {
  return Response.json(
    { error: 'Method not allowed.' },
    { status: 405, headers: { Allow: allow, 'Cache-Control': 'no-store' } },
  );
}

export function supportJson(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
