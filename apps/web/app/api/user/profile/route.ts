import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * PATCH /api/user/profile
 *
 * Updates the authenticated user's display name.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Validate the request body: displayName (1–100 chars, trimmed).
 *   3. Update `users.display_name` in the database.
 *   4. Sync the new name to Supabase Auth user metadata (full_name) so sidebar
 *      initials and any future auth-derived display are kept consistent.
 *   5. Return the updated displayName.
 *
 * Security:
 *   - Only the authenticated user's own row is updated (enforced by eq user.id).
 *   - RLS on the users table provides a second layer of isolation.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // 2. Parse and validate request body.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { displayName } = body as { displayName?: unknown };

  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (trimmed.length === 0) {
    return NextResponse.json(
      { error: 'Display name is required.' },
      { status: 400 },
    );
  }
  if (trimmed.length > 100) {
    return NextResponse.json(
      { error: 'Display name must be 100 characters or fewer.' },
      { status: 400 },
    );
  }

  // 3. Update the users table.
  const { error: updateError } = await supabase
    .from('users')
    .update({ display_name: trimmed, updated_at: new Date().toISOString() })
    .eq('id', user.id);

  if (updateError) {
    console.error('[profile-update] DB update failed:', updateError.message);
    return NextResponse.json({ error: 'Failed to update profile.' }, { status: 500 });
  }

  // 4. Sync to Supabase Auth user metadata so sidebar initials stay consistent
  //    without requiring a full page reload. Failures here are non-fatal:
  //    the primary data is the users table row updated above.
  const { error: metaError } = await supabase.auth.updateUser({
    data: { full_name: trimmed },
  });

  if (metaError) {
    // Log but don't fail the request: DB is the authoritative source.
    console.error('[profile-update] Auth metadata update failed:', metaError.message);
  }

  return NextResponse.json({ displayName: trimmed }, { status: 200 });
}
