import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ACTIVE_WORKSPACE_COOKIE } from '@/lib/workspace/active';
import { planDisplayName } from '@/lib/stripe/plans';

/**
 * POST /api/workspaces
 *
 * Creates a new workspace owned by the caller and makes it active.
 *
 * Body: { name: string }
 *
 * Gated to the Scale tier: the create_workspace() RPC raises P0001 unless the
 * caller's USER-LEVEL entitlement (user_billing.plan) is 'pro' (display name
 * "Scale"). Multiple workspaces is a Scale-only feature. The new workspace
 * inherits that plan. The subscription is tied to the user, so all of a user's
 * workspaces share one plan.
 */

const MAX_NAME_LEN = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { name } = body as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'A workspace name is required.' }, { status: 400 });
  }
  if (name.trim().length > MAX_NAME_LEN) {
    return NextResponse.json(
      { error: `Workspace name must be ${MAX_NAME_LEN} characters or fewer.` },
      { status: 400 },
    );
  }

  // create_workspace is not yet in the generated Database types, so call it
  // through a narrowly-typed view of rpc() rather than a blanket `any`.
  // NOTE: .rpc() is a prototype method that internally dereferences `this`
  // (`return this.rest.rpc(...)`). Casting it into a bare `const` detaches the
  // method, so `this` is undefined at call time and it throws a TypeError —
  // an unhandled 500. Bind it back to the client to preserve `this`.
  type CreatedWorkspace = { id: string; slug: string; display_name: string; plan: string };
  const rpc = (supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: CreatedWorkspace[] | null; error: { code: string; message: string } | null }>).bind(supabase);

  const { data, error } = await rpc('create_workspace', { p_name: name.trim() });

  if (error) {
    // P0001 covers both the not-authenticated and Pro-gate cases; the auth
    // check above rules out the former, so treat P0001 as the upgrade gate.
    if (error.code === 'P0001') {
      const teamName = planDisplayName('pro'); // "Scale"
      return NextResponse.json(
        {
          error: `Multiple workspaces is a ${teamName} feature. Upgrade to ${teamName} to create more workspaces.`,
          error_code: 'workspace_create_requires_pro',
          upgrade_url: '/pricing',
        },
        { status: 403 },
      );
    }
    console.error('[workspaces:create]', error.message);
    return NextResponse.json({ error: 'Failed to create workspace.' }, { status: 500 });
  }

  // create_workspace RETURNS TABLE → supabase returns an array of one row.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) {
    return NextResponse.json({ error: 'Failed to create workspace.' }, { status: 500 });
  }

  // Make the new workspace the active one so the dashboard lands on it.
  const res = NextResponse.json(
    {
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      plan: row.plan,
    },
    { status: 201 },
  );
  res.cookies.set(ACTIVE_WORKSPACE_COOKIE, row.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
