import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { encryptToken } from '@/lib/crypto';
import { checkInboxLimit, inboxExistsForEmail } from '@/lib/plans/check-inbox-limit';
import { validateImapCredential } from '@/lib/email/validate-imap';
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

  // 3. Parse and validate the request body.
  let service: string;
  let email: string;
  let appPassword: string;
  let region: string | undefined;
  // Zoho only. Whitelisted to the two known values; anything else (absent,
  // unknown, malformed) falls back to 'personal' so behavior is unchanged.
  let zohoAccountType = DEFAULT_ZOHO_ACCOUNT_TYPE;
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
    };
    service = typeof body.service === 'string' ? body.service.trim().toLowerCase() : '';
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    appPassword = typeof body.appPassword === 'string' ? body.appPassword.trim() : '';
    region = typeof body.region === 'string' ? body.region : undefined;
    if (isZohoAccountType(body.zohoAccountType)) zohoAccountType = body.zohoAccountType;
    // Optional login override: trim, drop if empty/whitespace, reject control
    // chars/newlines, cap at 255. Anything invalid falls back to null (use the
    // email address) so a malformed value never breaks the connect flow.
    if (typeof body.loginUsername === 'string') {
      const trimmed = body.loginUsername.trim();
      // eslint-disable-next-line no-control-regex
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

  // Zoho's host depends on the account's data center region AND account type:
  // personal (@zohomail.com) uses imap.zoho.<tld>; organization/custom-domain
  // accounts use the imappro.zoho.<tld> / smtppro.zoho.<tld> variants.
  const zoho = service === 'zoho' ? zohoHosts(region, zohoAccountType) : null;
  const imapHost = zoho ? zoho.imapHost : preset.imapHost;
  const smtpHost = zoho ? zoho.smtpHost : preset.smtpHost;

  // 4. Enforce the plan inbox cap for brand-new addresses only (reconnects reuse
  //    the existing row via upsert and must be allowed even at the cap).
  const alreadyConnected = await inboxExistsForEmail(supabase, workspaceId, email);
  if (!alreadyConnected) {
    const inboxLimit = await checkInboxLimit(supabase, workspaceId);
    if (inboxLimit.atLimit) {
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
    // AUTH_FAILED means the mail server rejected the credentials (wrong app
    // password / account-level auth issue). Surface a structured error_code so
    // the client can distinguish a credential rejection from other 422 causes
    // (bad input, unsupported provider, etc.). All other error codes retain
    // their own messages with no extra error_code (network / TLS / protocol
    // errors are handled separately and the message is already actionable).
    const body: Record<string, string> = { error: validation.message };
    if (validation.code === 'AUTH_FAILED') body.error_code = 'auth_failed';
    return NextResponse.json(body, { status: 422 });
  }

  // 6. Encrypt the app password: never store plaintext.
  const encryptedPassword = encryptToken(appPassword);

  // 7. Upsert. provider = 'imap' (transport), service = brand (UX/serve hint).
  //    smtp_tls is always true; the edge function infers implicit-TLS vs
  //    STARTTLS from smtp_port (587 → STARTTLS, otherwise implicit TLS).
  const { error: upsertError } = await supabase.from('inboxes').upsert(
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
      smtp_host: smtpHost,
      smtp_port: preset.smtpPort,
      smtp_tls: true,
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
    console.error('[app-password] Upsert failed:', upsertError.message);
    return NextResponse.json({ error: 'Failed to save inbox. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
