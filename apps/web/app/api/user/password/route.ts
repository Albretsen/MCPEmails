import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * PATCH /api/user/password
 *
 * Changes the authenticated user's password after verifying their current one.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Validate the request body: currentPassword and newPassword.
 *   3. Verify the current password by calling supabase.auth.signInWithPassword.
 *      If incorrect, return 400 with a clear error message.
 *   4. Update the password via supabase.auth.updateUser({ password: newPassword }).
 *   5. Return { success: true }.
 *
 * Security:
 *   - Requires a valid session cookie (authenticated dashboard user).
 *   - Verifies the current password before allowing any change, preventing
 *     a session-hijacking attack from silently resetting the password.
 *   - New password minimum 8 characters enforced server-side (in addition to
 *     client-side validation).
 *   - Passwords are never logged.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();

  // 1. Authenticate: reject unauthenticated callers immediately.
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

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { currentPassword, newPassword } = body as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    return NextResponse.json(
      { error: 'Current password is required.' },
      { status: 400 },
    );
  }

  if (typeof newPassword !== 'string' || newPassword.length === 0) {
    return NextResponse.json(
      { error: 'New password is required.' },
      { status: 400 },
    );
  }

  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: 'New password must be at least 8 characters.' },
      { status: 400 },
    );
  }

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: 'New password must be different from your current password.' },
      { status: 400 },
    );
  }

  if (!user.email) {
    // OAuth-only accounts have no password to change.
    return NextResponse.json(
      { error: 'Password change is not available for accounts without an email/password login.' },
      { status: 400 },
    );
  }

  // 3. Verify the current password by re-authenticating with email + password.
  //    This proves the caller knows the existing credential before we allow a change.
  //    On success, signInWithPassword refreshes the user's session cookies,
  //    an acceptable side-effect that keeps the session alive post-change.
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (signInError) {
    // Do not reveal whether the account exists or describe the exact failure.
    return NextResponse.json(
      { error: 'Current password is incorrect.' },
      { status: 400 },
    );
  }

  // 4. Update the password for the authenticated user.
  const { error: updateError } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (updateError) {
    console.error('[password-change] updateUser failed:', updateError.message);
    return NextResponse.json(
      { error: 'Failed to update password. Please try again.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
