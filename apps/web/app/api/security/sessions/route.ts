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
 * Returns generic fallbacks when the string is null or unrecognised.
 */
function parseDevice(ua: string | null): DeviceInfo {
  if (!ua) return { browser: 'Unknown browser', os: 'Unknown device' };

  // Browser — order matters: Edge contains "Chrome", OPR contains "Opera"
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
  else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';
  else if (/curl/i.test(ua)) browser = 'curl';
  else if (/python-requests|python\//i.test(ua)) browser = 'Python';
  else if (/axios/i.test(ua)) browser = 'HTTP client';

  // OS — check mobile first so "iPhone" beats "Macintosh"
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
 * Returns null when the token is malformed or the claim is absent — callers
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

  // 1. Verify auth — getUser() makes a server-side token validation call.
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
 * Signs out all active sessions for the authenticated user EXCEPT the current one.
 * Uses Supabase Auth's built-in `scope: 'others'` sign-out which invalidates all
 * refresh tokens except the one belonging to the calling session.
 *
 * After this call, any other device/browser the user is logged into will be
 * prompted to re-authenticate on their next request.
 *
 * Security:
 *   - Requires a valid Supabase session cookie.
 *   - Does not affect the current session — the user remains logged in here.
 */
export async function DELETE(_request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Verify auth.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Revoke all other refresh tokens for this user. The current session's
  //    refresh token is preserved — the calling browser stays logged in.
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
