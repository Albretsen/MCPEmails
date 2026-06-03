import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * POST /api/user/email
 *
 * Starts a change of the authenticated user's account email.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Validate the request body: email (well-formed, ≤ 254 chars, different
 *      from the current address).
 *   3. Call supabase.auth.updateUser({ email }). With Supabase's secure email
 *      change enabled this sends a confirmation link to the new address (and,
 *      when configured, the old one); the change only takes effect once the
 *      link is clicked. We never write the new email to the users table here —
 *      a DB trigger / next sign-in syncs it after confirmation.
 *   4. Return 200 with the pending address so the UI can tell the user to check
 *      their inbox.
 *
 * Security:
 *   - Only the authenticated user's own auth record is touched.
 *   - The email is not considered changed until the confirmation link is used,
 *     so a hijacked session cannot silently take over the account email.
 */

// Pragmatic email shape check. Authoritative validation is the confirmation
// link Supabase sends — this just rejects obviously malformed input early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
  }

  const { email } = body as { email?: unknown };
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (normalized.length === 0 || normalized.length > 254 || !EMAIL_RE.test(normalized)) {
    return NextResponse.json(
      { error: 'Enter a valid email address.' },
      { status: 400 },
    );
  }

  if (normalized === (user.email ?? '').toLowerCase()) {
    return NextResponse.json(
      { error: 'That is already your account email.' },
      { status: 400 },
    );
  }

  // 3. Kick off the confirmation flow.
  const { error: updateError } = await supabase.auth.updateUser({ email: normalized });

  if (updateError) {
    // Surface the common, actionable cases; fall back to a generic message.
    const code = (updateError as { code?: string }).code;
    const msg = updateError.message ?? '';
    if (code === 'email_exists' || /already (been )?registered|already in use/i.test(msg)) {
      return NextResponse.json(
        { error: 'That email is already in use by another account.' },
        { status: 409 },
      );
    }
    if (code === 'over_email_send_rate_limit' || updateError.status === 429) {
      return NextResponse.json(
        { error: 'Too many requests. Try again in a few minutes.' },
        { status: 429 },
      );
    }
    console.error('[email-change] updateUser failed:', msg);
    return NextResponse.json({ error: 'Failed to start email change.' }, { status: 500 });
  }

  // 4. Confirmation email sent; change is pending until the link is clicked.
  return NextResponse.json({ pendingEmail: normalized }, { status: 200 });
}
