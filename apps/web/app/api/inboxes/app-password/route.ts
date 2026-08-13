import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';
import { validateImapCredential } from '@/lib/email/validate-imap';
import { validateSmtpCredential } from '@/lib/email/validate-smtp';
import { yandexLoginUsername } from '@/lib/email/connection-config';
import { findConflictingInbox } from '@/lib/email/imap-login-collision';
import { captureError } from '@/lib/errors/capture';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import {
  IMAP_PRESETS,
  isBrandedImapService,
  isZohoAccountType,
  zohoHosts,
  DEFAULT_ZOHO_ACCOUNT_TYPE,
} from '@/lib/email-providers/imap-presets';

/**
 * POST /api/inboxes/app-password
 *
 * Connects a branded IMAP provider (iCloud, Yahoo, Zoho, Yandex) using an
 * app-specific password. Host/port settings come from the preset registry
 * (lib/email-providers/imap-presets.ts); the credential is validated against
 * the provider's IMAP server before anything is persisted.
 *
 * All such inboxes are stored with provider = 'imap' and a `service` tag; the
 * edge function serves them through its generic IMAP/SMTP path (Phase 1).
 *
 * Body: { service, email, appPassword, region?, zohoAccountType?, loginUsername? }
 *   region/zohoAccountType apply to Zoho only and select the data-center host
 *   and the personal vs organization (imappro/smtppro) host variant.
 *   loginUsername is an optional IMAP/SMTP login distinct from the email address
 *   (e.g. Yandex 360 custom-domain accounts). When present it is persisted to
 *   inboxes.imap_username and the edge function authenticates with it instead of
 *   the email address. When absent/blank, authentication uses the email address.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Authenticate.
  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Resolve the active workspace.
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found.' }, { status: 403 });
  }
  const db = createServiceRoleClient();

  // 3. Parse and validate the request body.
  let service: string;
  let email: string;
  let appPassword: string;
  let region: string | undefined;
  // Zoho only. Whitelisted to the two known values; anything else (absent,
  // unknown, malformed) falls back to 'personal' so behavior is unchanged.
  let zohoAccountType = DEFAULT_ZOHO_ACCOUNT_TYPE;
  let yandexAccountType: 'personal' | 'business' = 'personal';
  // Optional login override (e.g. Yandex 360 custom-domain accounts whose IMAP
  // login differs from the email address). null = use the email address.
  let loginUsername: string | null = null;

  try {
    const body = (await request.json()) as {
      service?: unknown;
      email?: unknown;
      appPassword?: unknown;
      region?: unknown;
      zohoAccountType?: unknown;
      loginUsername?: unknown;
      yandexAccountType?: unknown;
    };
    service = typeof body.service === 'string' ? body.service.trim().toLowerCase() : '';
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    appPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
    region = typeof body.region === 'string' ? body.region : undefined;
    if (isZohoAccountType(body.zohoAccountType)) zohoAccountType = body.zohoAccountType;
    if (body.yandexAccountType === 'business') yandexAccountType = 'business';
    // Optional login override: trim, drop if empty/whitespace, reject control
    // chars/newlines, cap at 255. Anything invalid falls back to null (use the
    // email address) so a malformed value never breaks the connect flow.
    if (typeof body.loginUsername === 'string') {
      const trimmed = body.loginUsername.trim();
      if (trimmed && trimmed.length <= 255 && !/[\x00-\x1f\x7f]/.test(trimmed)) {
        loginUsername = trimmed;
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!isBrandedImapService(service)) {
    return NextResponse.json({ error: 'Unsupported provider.' }, { status: 422 });
  }
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email address is required.' }, { status: 422 });
  }
  if (!appPassword || appPassword.length < 8) {
    return NextResponse.json({ error: 'App password is required.' }, { status: 422 });
  }

  const preset = IMAP_PRESETS[service];
  if (service === 'yandex' && !loginUsername) {
    loginUsername = yandexLoginUsername(email, yandexAccountType);
  }

  // Zoho's host depends on the account's data center region AND account type:
  // personal (@zohomail.com) uses imap.zoho.<tld>; organization/custom-domain
  // accounts use the imappro.zoho.<tld> / smtppro.zoho.<tld> variants.
  const zoho = service === 'zoho' ? zohoHosts(region, zohoAccountType) : null;
  const imapHost = zoho ? zoho.imapHost : preset.imapHost;
  const smtpHost = zoho ? zoho.smtpHost : preset.smtpHost;

  // 4. Enforce the plan inbox cap for brand-new addresses only (reconnects reuse
  //    the existing row via upsert and must be allowed even at the cap).
  const alreadyConnected = await inboxExistsForEmail(supabase, workspaceId, email);
  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'started', category: funnelProvider(service), phase: 'tcp', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, workspaceId);
    if (inboxLimit.atLimit) {
      await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: funnelProvider(service), errorCategory: 'plan_limit' });
      const capLabel = inboxLimit.maxInboxes === 1 ? '1 inbox' : `${inboxLimit.maxInboxes} inboxes`;
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

  // 5. Validate the credential against the provider's IMAP server. The SASL
  //    login uses the override when supplied (mirrors the edge function's
  //    imap_username || email_address resolution), otherwise the email address.
  const validation = await validateImapCredential({
    host: imapHost,
    port: preset.imapPort,
    email,
    username: loginUsername ?? undefined,
    password: appPassword,
  });

  if (!validation.ok) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: funnelProvider(service), errorCategory: validation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed', phase: validation.phase, connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
    // AUTH_FAILED means the mail server rejected the credentials (wrong app
    // password / account-level auth issue). Surface a structured error_code so
    // the client can distinguish a credential rejection from other 422 causes
    // (bad input, unsupported provider, etc.). All other error codes retain
    // their own messages with no extra error_code (network / TLS / protocol
    // errors are handled separately and the message is already actionable).
    const body: Record<string, string> = { error: validation.message };
    if (validation.code === 'AUTH_FAILED') body.error_code = 'auth_failed';
    // Every failure is recorded, AUTH_FAILED included. Skipping it used to look
    // like the right call (a wrong password is user-driven noise), but it left
    // a service that rejects *every* login indistinguishable from a typo, and
    // Yandex sat at 21 failures / 0 successes with nothing on file explaining
    // why. `detail` carries the sanitized server rejection (status + reason,
    // credential and address stripped, truncated), which is what separates
    // "this user mistyped" from "this provider never works": grouping
    // app_errors by service + reason + detail makes a systemic 100%-failure
    // provider visible immediately.
    await captureError(new Error(validation.message), {
      severity: 'low',
      route: 'api/inboxes/app-password',
      reason: validation.code,
      service,
      phase: validation.phase,
      detail: validation.detail ?? null,
      workspaceId,
    });
    return NextResponse.json(body, { status: 422 });
  }


  const smtpValidation = await validateSmtpCredential({
    host: smtpHost,
    port: preset.smtpPort,
    email,
    username: loginUsername ?? undefined,
    password: appPassword,
    security: preset.smtpSecurity,
  });
  if (!smtpValidation.ok) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: funnelProvider(service), errorCategory: smtpValidation.code === 'AUTH_FAILED' ? 'auth_failed' : 'validation_failed', phase: `smtp_${smtpValidation.phase}`, connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
    return NextResponse.json({ error: smtpValidation.message, error_code: smtpValidation.code.toLowerCase() }, { status: 422 });
  }

  // 6. Defense-in-depth: reject if another active inbox in this workspace
  //    already uses the same IMAP server + same effective login (imap_username
  //    || email_address) but a DIFFERENT address. Guards against the
  //    bonussok1 incident, where an autofilled login pointed a new address at
  //    an existing mailbox. Runs AFTER validation (so we only block real
  //    credentials) and BEFORE the upsert. Uses the service-role `db` (created
  //    here, also reused for the upsert) so the read sees every workspace row.
  const conflict = await findConflictingInbox(db, workspaceId, {
    host: imapHost,
    effectiveLogin: loginUsername || email,
    email,
  });
  if (conflict.conflict) {
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: funnelProvider(service), errorCategory: 'conflict' });
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

  // 8. Upsert. provider = 'imap' (transport), service = brand (UX/serve hint).
  //    smtp_tls is always true; the edge function infers implicit-TLS vs
  //    STARTTLS from smtp_port (587 → STARTTLS, otherwise implicit TLS).
  //    Use the service-role client: reconnecting a previously-disconnected
  //    address conflicts with its soft-deleted row, and the ON CONFLICT DO
  //    UPDATE would target a deleted_at-set row that the user RLS UPDATE policy
  //    (USING deleted_at IS NULL) rejects ("new row violates row-level security
  //    policy"). The workspace was already authorised, so the write is safe.
  const { error: upsertError } = await db.from('inboxes').upsert(
    {
      workspace_id: workspaceId,
      provider: 'imap',
      service,
      email_address: email,
      // Distinct SASL login when provided (e.g. Yandex 360 custom domains);
      // null restores the default of authenticating with the email address.
      imap_username: loginUsername,
      imap_host: imapHost,
      imap_port: preset.imapPort,
      imap_tls: true,
      imap_security: 'tls',
      smtp_host: smtpHost,
      smtp_port: preset.smtpPort,
      smtp_tls: true,
      smtp_security: preset.smtpSecurity,
      imap_password: encryptedPassword,
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
    await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'failure', category: funnelProvider(service), errorCategory: 'persistence_failed' });
    console.error('[app-password] Upsert failed:', upsertError.message);
    await captureError(new Error(upsertError.message), {
      severity: 'high',
      route: 'api/inboxes/app-password',
      reason: 'inbox_upsert_failed',
      service,
      workspaceId,
    });
    return NextResponse.json({ error: 'Failed to save inbox. Please try again.' }, { status: 500 });
  }

  await recordProductFunnelEvent(db, { workspaceId, stage: 'inbox_connection', outcome: 'success', category: funnelProvider(service), phase: 'complete', connectionType: alreadyConnected ? 'reconnect' : 'first_connect' });
  return NextResponse.json({ success: true });
}

function funnelProvider(service: string): 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'unknown' {
  return service === 'icloud' || service === 'yahoo' || service === 'zoho' || service === 'yandex' ? service : 'unknown';
}
