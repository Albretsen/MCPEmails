import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Shape returned by the get_current_user_sessions() Postgres function.
 * All columns from auth.sessions that are safe to expose to the client.
 */
interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  user_agent: string | null;
  ip: string | null;
  not_after: string | null;
  refreshed_at: string | null;
}

/**
 * Parsed device descriptor derived from a raw User-Agent string.
 */
interface DeviceInfo {
  browser: string;
  os: string;
}

/**
 * Parses a User-Agent string into a human-readable browser + OS label.
 *
 * Non-browser clients (curl, Python, Axios, raw HTTP tools, MCP clients, etc.)
 * are identified first. Only if the UA contains genuine browser signals is an
 * OS label derived. This prevents curl or other API clients from being labelled
 * "Chrome / macOS" just because their UA string happens to contain "Mozilla".
 *
 * Returns generic fallbacks when the string is null or unrecognised.
 */
function parseDevice(ua: string | null): DeviceInfo {
  if (!ua) return { browser: 'Unknown client', os: 'API' };

  // Detect known non-browser / API clients before looking for browser tokens.
  // Many of these embed "Mozilla" in their UA to appear browser-like, so they
  // must be matched before the browser detection block.
  if (/\bcurl\b/i.test(ua)) return { browser: 'curl', os: 'API client' };
  if (/python-requests/i.test(ua)) return { browser: 'Python (requests)', os: 'API client' };
  if (/^python\//i.test(ua)) return { browser: 'Python', os: 'API client' };
  if (/\baxios\b/i.test(ua)) return { browser: 'Axios', os: 'API client' };
  if (/\bgot\b\/|node-fetch|undici/i.test(ua)) return { browser: 'Node.js HTTP', os: 'API client' };
  if (/\bwget\b/i.test(ua)) return { browser: 'wget', os: 'API client' };
  if (/\bhttpie\b/i.test(ua)) return { browser: 'HTTPie', os: 'API client' };
  if (/\bpostman\b/i.test(ua)) return { browser: 'Postman', os: 'API client' };
  if (/\binsomnia\b/i.test(ua)) return { browser: 'Insomnia', os: 'API client' };

  // --- Genuine browser detection ---
  // A real browser UA always contains "Mozilla/5.0". Absence is a strong signal
  // that this is a non-browser script, even if none of the patterns above matched.
  if (!/Mozilla\/5\.0/i.test(ua)) {
    // Capture the first token of the UA as a label so the raw agent is visible.
    const firstToken = ua.split(/[\s/]/)[0] ?? 'Unknown client';
    return { browser: firstToken, os: 'API client' };
  }

  // Browser. Order matters: Edge contains "Chrome", OPR contains "Opera".
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';

  // OS. Check mobile first so "iPhone" beats "Macintosh".
  let os = 'Unknown OS';
  if (/iPhone/i.test(ua)) os = 'iPhone';
  else if (/iPad/i.test(ua)) os = 'iPad';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/CrOS/i.test(ua)) os = 'Chrome OS';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Linux/i.test(ua)) os = 'Linux';

  return { browser, os };
}

/**
 * Attempts to decode the Supabase JWT access token and extract the session_id
 * claim. Supabase Auth v2 includes session_id as a custom claim in the payload.
 *
 * Returns null when the token is malformed or the claim is absent; callers
 * should handle null gracefully (isCurrent will be false for all sessions).
 */
function extractSessionId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    // Add base64 padding if required
    const payload = parts[1];
    const padded = payload + '=='.slice(0, (4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf-8');
    const json = JSON.parse(decoded) as Record<string, unknown>;
    return typeof json['session_id'] === 'string' ? json['session_id'] : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/security/sessions
 *
 * Returns the list of active Supabase Auth sessions for the authenticated user.
 * The current session (the one making this request) is flagged with isCurrent=true.
 *
 * Sessions are sourced from auth.sessions via the get_current_user_sessions()
 * SECURITY DEFINER function (which restricts rows to auth.uid() only).
 *
 * Response shape:
 *   { sessions: SessionEntry[] }
 *
 * SessionEntry fields:
 *   id, browser, os, ip, createdAt, lastActiveAt, isCurrent
 *
 * Security:
 *   - Requires a valid Supabase session cookie (dashboard auth).
 *   - The RPC enforces user isolation via auth.uid().
 *   - IP addresses are returned as strings; no other PII is included.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Verify auth: getUser() makes a server-side token validation call.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Determine which session is "current" by decoding the JWT's session_id claim.
  //    getSession() is safe here: we only need the token string, not auth verification.
  const {
    data: { session: currentSession },
  } = await supabase.auth.getSession();

  const currentSessionId = currentSession?.access_token
    ? extractSessionId(currentSession.access_token)
    : null;

  // 3. Fetch all active sessions for auth.uid() via the SECURITY DEFINER RPC.
  const { data: rows, error: rpcError } = await supabase.rpc(
    'get_current_user_sessions',
  );

  if (rpcError) {
    console.error('[sessions:GET] rpc failed:', rpcError.message);
    return NextResponse.json({ error: 'Failed to load sessions.' }, { status: 500 });
  }

  // 4. Map rows to safe, client-readable shape.
  const sessions = ((rows ?? []) as SessionRow[]).map((row) => {
    const { browser, os } = parseDevice(row.user_agent);
    return {
      id: row.id,
      browser,
      os,
      ip: row.ip ?? null,
      createdAt: row.created_at,
      lastActiveAt: row.refreshed_at ?? row.updated_at,
      isCurrent: currentSessionId !== null ? row.id === currentSessionId : false,
    };
  });

  return NextResponse.json({ sessions });
}

/**
 * DELETE /api/security/sessions
 *
 * Two modes, selected by the request body:
 *
 * 1. Per-session revoke (body: { sessionId: string })
 *    Revokes a single specific session by deleting its row from auth.sessions
 *    via the public.revoke_user_session() SECURITY DEFINER RPC (called through
 *    the user/RLS client). The RPC scopes the delete to auth.uid(), so the caller
 *    can only ever revoke their own session. The current session cannot be
 *    self-revoked this way.
 *
 *    auth.sessions is not exposed by PostgREST, so the RPC is the supported
 *    server-side path (the Auth server checks this table on every refresh-token
 *    exchange, so removing the row invalidates the device).
 *
 * 2. Bulk revoke (no body / body without sessionId)
 *    Signs out all active sessions EXCEPT the current one using Supabase Auth's
 *    built-in `scope: 'others'` mechanism, which invalidates all refresh tokens
 *    except the one belonging to the calling session.
 *
 * Security:
 *   - Requires a valid Supabase session cookie.
 *   - Per-session: enforces user_id ownership before deletion.
 *   - Bulk: does not affect the current session; the user stays logged in here.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Verify auth.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Parse optional body.
  let sessionId: string | null = null;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body?.sessionId === 'string' && body.sessionId) {
      sessionId = body.sessionId;
    }
  } catch {
    // No body or non-JSON body → bulk mode.
  }

  // 3a. Per-session revoke: delete the specific auth.sessions row.
  if (sessionId) {
    // Determine the current session so we can block self-revoke.
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession();
    const currentSessionId = currentSession?.access_token
      ? extractSessionId(currentSession.access_token)
      : null;

    if (currentSessionId && sessionId === currentSessionId) {
      return NextResponse.json(
        { error: 'Cannot revoke the current session this way. Use sign-out instead.' },
        { status: 400 },
      );
    }

    // auth.sessions lives in the `auth` schema, which PostgREST does NOT expose
    // (only public + graphql_public). Querying it via .schema('auth').from(...)
    // returns PGRST106 and 500s every time. Instead we call a public-schema
    // SECURITY DEFINER RPC (revoke_user_session) through the user (RLS) client.
    // The function deletes auth.sessions WHERE id = $1 AND user_id = auth.uid(),
    // so ownership is enforced server-side and a foreign/nonexistent id simply
    // returns zero rows -> 404.
    const { data: revoked, error: rpcError } = await supabase.rpc(
      'revoke_user_session',
      { p_session_id: sessionId },
    );

    if (rpcError) {
      console.error('[sessions:DELETE] revoke_user_session rpc failed:', rpcError.message);
      return NextResponse.json({ error: 'Failed to revoke session.' }, { status: 500 });
    }

    // The RPC returns one row ({ revoked_session_id }) on success, zero rows when
    // the session does not exist or belongs to another user.
    if (!revoked || (Array.isArray(revoked) && revoked.length === 0)) {
      return NextResponse.json({ error: 'Session not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true, revokedSessionId: sessionId });
  }

  // 3b. Bulk revoke: revoke all other refresh tokens for this user.
  //     The current session's refresh token is preserved: the calling browser stays logged in.
  const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' });

  if (signOutError) {
    console.error('[sessions:DELETE] sign out others failed:', signOutError.message);
    return NextResponse.json(
      { error: 'Failed to sign out other sessions.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
