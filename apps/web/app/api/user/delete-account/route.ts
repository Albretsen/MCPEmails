import { NextRequest, NextResponse, after } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { selectAllRows } from '@/lib/supabase/paginate';
import { stripe } from '@/lib/stripe/client';
import { cancelSubscriptionsForDeletedAccount } from '@/lib/stripe/cancel-on-account-delete';
import { cancelQueuedMail, revokeGmailGrantsForWorkspaces } from '@/lib/inboxes/teardown';
import { accountDeletedLocale, sendAccountDeletedEmail } from '@/lib/email/account-deleted';

/**
 * DELETE /api/user/delete-account
 *
 * Soft-deletes every workspace the authenticated user owns (and all associated
 * data), removes the user from any workspace they were invited to, then signs
 * them out.
 *
 * Steps:
 *   1. Authenticate the requesting user via Supabase session cookie.
 *   2. Validate the request body: confirmEmail must exactly match the user's email.
 *   3. Look up ALL workspaces the user owns.
 *   3b. Cancel the user's Stripe subscriptions immediately. If Stripe fails,
 *      stop here: nothing is torn down and the account stays usable, rather
 *      than leaving a subscription charging an account that no longer exists.
 *   3c. Revoke the Google grant of every Gmail inbox in the owned workspaces,
 *      while the tokens still exist. Best effort, never blocks.
 *   4. For each owned workspace: revoke API keys + OAuth refresh chains,
 *      disconnect inboxes and null their encrypted credentials, drop pending
 *      invites, and soft-delete the workspace. Then cancel the scheduled
 *      sends and held approvals queued for those inboxes (best effort).
 *   4b. In EVERY workspace (owned or not): revoke the user's own API keys and
 *      OAuth refresh chains and delete their pending authorization codes.
 *   5. Remove the user's membership rows everywhere (owned + invited).
 *   6. Ban the auth user via the service-role admin API (~100-year ban_duration)
 *      so the credentials can no longer be used to log in. Its
 *      app_metadata.deleted_at stamp is copied to public.users.deleted_at by
 *      a trigger, which starts the 30-day purge clock.
 *   7. Sign the user out (invalidate session cookies).
 *   8. After the response: the confirmation email (lib/email/account-deleted).
 *   9. Return { success: true }.
 *
 * The 30-day purge (migration 20261030130000, purge_deleted_accounts()):
 * everything above is a soft delete. A daily job erases what is left once
 * public.users.deleted_at is 30 days old: the account's activity log, auth
 * log, support-ticket contents, and then the auth.users row itself, which
 * cascades to public.users, the owned workspaces and everything under them.
 * Until then the banned row keeps the email address taken.
 *
 * Security:
 *   - Requires a valid session cookie.
 *   - Requires exact email confirmation: prevents accidental or CSRF-driven deletion.
 *   - Only the workspace owner may delete it (verified via the owner_id lookup
 *     on the authenticated client below).
 *   - The soft-delete mutations use the service-role client: setting deleted_at
 *     moves each row out of its SELECT policy (deleted_at IS NULL, or, for
 *     workspaces, my_workspace_ids() no longer returning the id), which
 *     Postgres rejects under the user's RLS context as "new row violates
 *     row-level security policy". Authorization is fully established before any
 *     mutation, and every write is scoped to the owned workspace_id.
 *   - After teardown, the auth user is permanently banned (ban_duration ~100 years)
 *     via auth.admin.updateUserById so that credentials can never be reused to log in.
 *   - No credentials, tokens, or secrets are logged.
 *   - Data is soft-deleted here and purged 30 days later (see above).
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
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

  const { confirmEmail, locale: requestedLocale } = body as { confirmEmail?: unknown; locale?: unknown };

  if (typeof confirmEmail !== 'string' || confirmEmail.trim().length === 0) {
    return NextResponse.json(
      { error: 'Email confirmation is required.' },
      { status: 400 },
    );
  }

  // Compare case-insensitively to be tolerant of capitalisation differences.
  if (confirmEmail.trim().toLowerCase() !== (user.email ?? '').toLowerCase()) {
    return NextResponse.json(
      { error: 'Email address does not match. Please type your exact email address.' },
      { status: 400 },
    );
  }

  // 3. Fetch ALL workspaces owned by this user (a Pro user may own several).
  //    Paged deliberately: PostgREST truncates an unpaged select at
  //    `db-max-rows` (1000) without raising an error, and this id list is what
  //    every teardown step in 4 is scoped to. A short list would leave live
  //    workspaces, API keys and encrypted inbox credentials behind on an
  //    account the user believes is deleted, while still returning success.
  const service = createServiceRoleClient();
  const { data: ownedWorkspaces, error: workspaceError } = await selectAllRows<{
    id: string;
    stripe_customer_id: string | null;
    acquisition_locale: string | null;
  }>((from, to) =>
    service
      .from('workspaces')
      .select('id, stripe_customer_id, acquisition_locale')
      .eq('owner_id', user.id)
      .is('deleted_at', null)
      // Total order: OFFSET paging over an unordered read may repeat or skip
      // rows between pages, and a skipped row here is a workspace whose
      // credentials survive the account deletion.
      .order('id', { ascending: true })
      .range(from, to),
  );

  if (workspaceError) {
    console.error('[delete-account] workspace lookup failed:', workspaceError.message);
    return NextResponse.json(
      { error: 'Failed to look up account data.' },
      { status: 500 },
    );
  }

  const ownedIds = ownedWorkspaces.map((w) => w.id);
  const now = new Date().toISOString();

  // 3b. Stop billing BEFORE anything is torn down. The subscription lives in
  //     Stripe and nothing else (no trigger, no edge function, not the webhook)
  //     cancels it when an account goes away. The customer is user-level
  //     (user_billing); the legacy per-workspace column is read too, because
  //     the webhook still writes it and a customer found only there would
  //     otherwise keep charging.
  const { data: billing, error: billingError } = await service
    .from('user_billing')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (billingError) {
    console.error('[delete-account] billing lookup failed:', billingError.message);
    return NextResponse.json(
      { error: 'Could not check your subscription, so your account was not deleted. Please try again.' },
      { status: 500 },
    );
  }

  const customerIds = [
    billing?.stripe_customer_id,
    ...ownedWorkspaces.map((w) => w.stripe_customer_id),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  try {
    await cancelSubscriptionsForDeletedAccount(stripe, customerIds);
  } catch (err) {
    console.error(
      '[delete-account] subscription cancel failed:',
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json(
      { error: 'Could not cancel your subscription, so your account was not deleted. Please try again or contact support.' },
      { status: 502 },
    );
  }

  // 3c. Revoke the Google grant of every Gmail inbox the account owns, while
  //     the encrypted tokens still exist (step 4 nulls them). Best effort and
  //     bounded (5 s per call, all in parallel); a failure never blocks the
  //     deletion, and the grant then lapses with the nulled token.
  await revokeGmailGrantsForWorkspaces(service, ownedIds, { label: 'delete-account' });

  // 4. Tear down every owned workspace: revoke keys + refresh chains, disconnect
  //    inboxes AND wipe their encrypted credentials, drop pending invites, then
  //    soft-delete the workspace. All scoped to the owned workspace ids.
  if (ownedIds.length > 0) {
    const steps = [
      // Soft-delete API keys.
      service.from('api_keys')
        .update({ deleted_at: now, updated_at: now })
        .in('workspace_id', ownedIds).is('deleted_at', null),
      // Kill OAuth refresh-token chains so connections can't resurrect.
      service.from('oauth_refresh_tokens')
        .update({ revoked_at: now })
        .in('workspace_id', ownedIds).is('revoked_at', null),
      // Disconnect inboxes AND null the encrypted credential columns (no PII left at rest).
      service.from('inboxes')
        .update({
          deleted_at: now,
          status: 'revoked',
          updated_at: now,
          oauth_access_token: null,
          oauth_refresh_token: null,
          imap_password: null,
        })
        .in('workspace_id', ownedIds).is('deleted_at', null),
      // Remove pending invites.
      service.from('workspace_invites').delete().in('workspace_id', ownedIds),
      // Soft-delete the workspaces themselves.
      service.from('workspaces')
        .update({ deleted_at: now, updated_at: now })
        .in('id', ownedIds),
    ];

    const results = await Promise.all(steps);
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      console.error('[delete-account] teardown failed:', failed.error.message);
      return NextResponse.json(
        { error: 'Failed to delete account data. Please try again.' },
        { status: 500 },
      );
    }

    // Queued scheduled sends and held approvals of those inboxes are
    // cancelled and their stored message removed. Best effort.
    await cancelQueuedMail(service, { workspaceIds: ownedIds }, 'delete-account');
  }

  // 4b. Revoke the user's OWN credentials in every workspace, owned or not.
  //     Step 4 covers owned workspaces only; in a team workspace the user was
  //     merely a member of, dropping the membership row in step 5 would leave
  //     every key they minted there, and every OAuth chain that can mint more,
  //     fully live: the MCP server authenticates on the key alone, and the auth
  //     ban below blocks Supabase logins, not mcpe_ bearer keys. Scoped by the
  //     user's id rather than a workspace list, so it also reaches a workspace
  //     whose membership row is already gone. Must run BEFORE step 5, so a
  //     failure leaves an over-revoked member, never an ex-member with live keys.
  {
    const ownCredentialSteps = [
      service.from('api_keys')
        .update({ deleted_at: now, updated_at: now })
        .eq('created_by', user.id).is('deleted_at', null),
      service.from('oauth_refresh_tokens')
        .update({ revoked_at: now })
        .eq('user_id', user.id).is('revoked_at', null),
      service.from('oauth_auth_codes')
        .delete()
        .eq('user_id', user.id),
    ];
    const ownResults = await Promise.all(ownCredentialSteps);
    const ownFailed = ownResults.find((r) => r.error);
    if (ownFailed?.error) {
      console.error('[delete-account] credential revocation failed:', ownFailed.error.message);
      return NextResponse.json(
        { error: 'Failed to delete account data. Please try again.' },
        { status: 500 },
      );
    }
  }

  // 5. Remove the user from ALL workspaces (owned + any they were invited to),
  //    so no dangling membership remains after the account is gone.
  const { error: membershipError } = await service
    .from('workspace_members')
    .delete()
    .eq('user_id', user.id);

  if (membershipError) {
    console.error('[delete-account] membership removal failed:', membershipError.message);
    return NextResponse.json(
      { error: 'Failed to delete account. Please try again.' },
      { status: 500 },
    );
  }

  // 6. Ban the auth user so they can never log in again, even though the
  //    auth.users row is kept until the 30-day purge. We set a ban_duration of
  //    ~100 years (876_600 h) and stamp app_metadata.deleted_at. A trigger on
  //    auth.users (migration 20261030130000) copies that stamp onto
  //    public.users.deleted_at, which starts the purge clock.
  //    This uses the service-role admin API (requires SUPABASE_SERVICE_ROLE_KEY).
  //    Failure is non-fatal: the workspace data is already destroyed; we log it
  //    and continue so the caller still gets a clean response.
  const { error: banError } = await service.auth.admin.updateUserById(user.id, {
    ban_duration: '876600h',
    app_metadata: { deleted_at: now },
  });
  if (banError) {
    console.error('[delete-account] auth ban failed (non-fatal):', banError.message);
  }

  // 7. Sign the user out to invalidate all session cookies.
  //    Failures here are non-fatal: the workspace is already deleted and the
  //    user will be locked out on next page load regardless.
  const { error: signOutError } = await supabase.auth.signOut();
  if (signOutError) {
    console.error('[delete-account] signOut failed (non-fatal):', signOutError.message);
  }

  // 8. The written confirmation, after the response. Language: the dashboard's
  //    interface locale when it sent one, else the landing-page locale of an
  //    owned workspace, else English.
  const to = user.email;
  if (to) {
    const locale =
      accountDeletedLocale(requestedLocale) ??
      accountDeletedLocale(ownedWorkspaces.find((w) => w.acquisition_locale)?.acquisition_locale) ??
      'en';
    const deletedAt = new Date(now);
    after(() => sendAccountDeletedEmail({ to, deletedAt, locale }));
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
