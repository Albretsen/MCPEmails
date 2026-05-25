/**
 * RFC 6749 §5.2 error response helper used by the token, revoke, and
 * register endpoints. Always includes no-cache and CORS headers.
 */
export function oauthError(
  error: string,
  errorDescription: string,
  status: number = 400,
  extraHeaders: Record<string, string> = {}
): Response {
  return Response.json(
    { error, error_description: errorDescription },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Access-Control-Allow-Origin': '*',
        ...extraHeaders,
      },
    }
  );
}
