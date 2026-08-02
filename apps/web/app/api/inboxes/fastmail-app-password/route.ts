import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';
import { validateImapCredential } from '@/lib/email/validate-imap';
import { findConflictingInbox } from '@/lib/email/imap-login-collision';
import { captureError } from '@/lib/errors/capture';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';

/**
 * POST /api/inboxes/fastmail-app-password
 *
 * Connects a Fastmail inbox using an app password (as an alternative to OAuth).
 * The handler:
 *
 *  1. Validates the authenticated user and resolves their workspace.
 *  2. Sanitises and validates the submitted email + app password fields.
 *  3. Opens a TLS socket to imap.fastmail.com:993 and attempts AUTH PLAIN via
 *     the shared `validateImapCredential` helper. If authentication fails the
 *     request is rejected with a 422 and no data is persisted.
 *  4. AES-256-GCM encrypts the app password before any database write.
 *  5. Upserts the inbox row (conflict target: workspace_id + email_address)
 *     so reconnection reuses the same UUID, preserving activity_log references.
 *
 * Security:
 *  - The app password is never logged.
 *  - The plaintext app password is only held in memory for the duration of
 *    the IMAP validation call and the encryptToken call.
 *  - The encrypted value is stored in imap_password; oauth_* columns are NULL.
 *
 * References:
 *   Documents/Architecture/email-provider-oauth-flows.md §4 (app-password section)
 *   Documents/Architecture/imap-smtp-connection-management.md §5 (Fastmail)
 */

const FASTMAIL_IMAP_HOST = 'imap.fastmail.com';
const FASTMAIL_IMAP_PORT = 993;

/**
 * Fastmail-specific override for the AUTH_FAILED message; all other codes fall
 * back to the validator's provider-neutral message. Includes the username hint
 * for custom-domain accounts whose IMAP login differs from their email address,
 * keeping parity with the generic provider message.
 */
const FASTMAIL_AUTH_FAILED_MESSAGE =
  'The mail server rejected these credentials. Make sure you are using a ' +
  'Fastmail app password (not your main Fastmail password). Custom-domain ' +
  'accounts may also require a separate IMAP username.';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify the user is authenticated.
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Resolve the active workspace (cookie-aware, multi-workspace safe).
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);

  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  const db = createServiceRoleClient();

  // 3. Parse and validate the request body.
  let email: string;
  let appPassword: string;

  try {
    const body = (await request.json()) as { email?: unknown; appPassword?: unknown };
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    appPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 422 });
  }

  if (!appPassword || appPassword.length < 8) {
    return NextResponse.json({ error: 'App password is required.' }, { status: 422 });
  }

  // 4. Enforce the plan inbox cap, but only for a brand-new address. A
  //    reconnect (the email already has a non-deleted inbox) reuses the
  //    existing row via upsert, so it must be allowed even at the cap.
  //    Return 402 (Payment Required) so the client can distinguish a plan
  //    limit from a credential error.
  const alreadyConnected = await inboxExistsForEmail(supabase, workspaceId, email);
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, workspaceId);
    if (inboxLimit.atLimit) {
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'fastmail', errorCategory: 'plan_limit' });
      const capLabel = inboxLimit.maxInboxes === 1
        ? '1 inbox'
        : `${inboxLimit.maxInboxes} inboxes`;
      return NextResponse.json(
        {
          error: `Your ${inboxLimit.plan} plan allows ${capLabel}. ` +
            `Upgrade at mcpemails.com/pricing to connect more.`,
          error_code: 'inbox_limit_reached',
          plan: inboxLimit.plan,
          current_count: inboxLimit.currentCount,
          max_inboxes: inboxLimit.maxInboxes,
        },
        { status: 402 }
      );
    }
  }

  // 5. Validate via IMAP before persisting anything.
  const validation = await validateImapCredential({
    host: FASTMAIL_IMAP_HOST,
    port: FASTMAIL_IMAP_PORT,
    email,
    password: appPassword,
  });

  if (!validation.ok) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'fastmail', errorCategory: validation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed' });
    // AUTH_FAILED → Fastmail-specific message with app-password hint; include
    // a structured error_code so the client can distinguish a credential
    // rejection from other 422s (missing fields, network errors, etc.).
    const isAuthFailed = validation.code === 'AUTH_FAILED';
    const userMessage = isAuthFailed ? FASTMAIL_AUTH_FAILED_MESSAGE : validation.message;
    const body: Record<string, string> = { error: userMessage };
    if (isAuthFailed) body.error_code = 'auth_failed';
    // A wrong password is expected/user-driven and not worth recording; the
    // other codes indicate a real infra/config issue worth tracking frequency
    // of — this table previously had zero writes anywhere in the codebase.
    if (!isAuthFailed) {
      await captureError(new Error(validation.message), {
        severity: 'low',
        route: 'api/inboxes/fastmail-app-password',
        reason: validation.code,
        workspaceId,
      });
    }
    return NextResponse.json(body, { status: 422 });
  }

  // 6. Defense-in-depth: reject if another active inbox in this workspace
  //    already uses the same IMAP server + same effective login but a DIFFERENT
  //    address. Guards against the bonussok1 incident, where an autofilled
  //    login pointed a new address at an existing mailbox. Fastmail has no
  //    username override, so the effective login is just the email address.
  //    Runs AFTER validation (so we only block real credentials) and BEFORE the
  //    upsert. Uses the service-role `db` (created here, also reused for the
  //    upsert) so the read sees every workspace row.
  const conflict = await findConflictingInbox(db, workspaceId, {
    host: FASTMAIL_IMAP_HOST,
    effectiveLogin: email,
    email,
  });
  if (conflict.conflict) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'fastmail', errorCategory: 'conflict' });
    return NextResponse.json(
      {
        error: `This mailbox login is already connected as ${conflict.address}. ` +
          `Each email address needs its own IMAP login — check the username field (it may have been autofilled with another account's login).`,
        error_code: 'login_already_connected',
      },
      { status: 422 },
    );
  }

  // 7. Encrypt the app password: never store plaintext.
  const encryptedPassword = encryptToken(appPassword);

  // 8. Upsert the inbox row.
  //    Conflict target: workspace_id + email_address. Reconnection reuses the
  //    same UUID, keeping activity_log references intact.
  //    Use the service-role client: when reconnecting a previously-disconnected
  //    address the conflict resolves to its soft-deleted row, and the ON
  //    CONFLICT DO UPDATE would touch a deleted_at-set row that the user RLS
  //    UPDATE policy (USING deleted_at IS NULL) rejects ("new row violates
  //    row-level security policy"). The workspace was already authorised above.
  const { error: upsertError } = await db.from('inboxes').upsert(
    {
      workspace_id: workspaceId,
      // Fastmail app passwords grant IMAP/SMTP, not JMAP. Store as a branded
      // IMAP inbox (like iCloud/Yahoo/Zoho) so every operation routes over the
      // transport the credential actually grants; `service` carries the brand
      // for the dashboard label/logo. provider 'fastmail' = OAuth/JMAP only.
      provider: 'imap',
      service: 'fastmail',
      email_address: email,
      imap_host: FASTMAIL_IMAP_HOST,
      imap_port: FASTMAIL_IMAP_PORT,
      imap_tls: true,
      smtp_host: 'smtp.fastmail.com',
      smtp_port: 465,
      smtp_tls: true,
      imap_password: encryptedPassword,
      // OAuth fields are NULL for app-password connections.
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_token_expires_at: null,
      oauth_scope: null,
      status: 'active',
      last_error: null,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: 'workspace_id, email_address',
      ignoreDuplicates: false,
    }
  );

  if (upsertError) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: 'fastmail', errorCategory: 'persistence_failed' });
    console.error('[fastmail-app-password] Upsert failed:', upsertError.message);
    await captureError(new Error(upsertError.message), {
      severity: 'high',
      route: 'api/inboxes/fastmail-app-password',
      reason: 'inbox_upsert_failed',
      workspaceId,
    });
    return NextResponse.json(
      { error: 'Failed to save inbox. Please try again.' },
      { status: 500 }
    );
  }

  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'success', category: 'fastmail' });
  return NextResponse.json({ success: true });
}
