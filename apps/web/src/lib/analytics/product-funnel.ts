import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/** Every caller passes a schema-typed client (service-role or cookie-bound). */
type Db = SupabaseClient<Database>;
import { safeDiagnosticPhase } from '@/lib/email/connection-config';
import type { AuthFailureReason } from '@/lib/email/auth-failure';
import type { CancelReason } from '@/lib/billing/cancel-reasons';
import { parseConnectEntryPoint } from '@/lib/analytics/connect-entry-point.mjs';
import type { OnboardingStepCategory } from '@/lib/onboarding/flow';
import type { OnboardingAssistCategory } from '@/lib/onboarding/assist';

/**
 * Which control opened the connect modal. The closed list lives in
 * lib/analytics/connect-entry-point.mjs, shared with the browser.
 */
export type ConnectEntryPoint =
  | 'header' | 'inboxes_page' | 'guide' | 'multi_inbox_overview' | 'multi_inbox_inboxes'
  | 'post_checkout' | 'first_run' | 'provider_intent' | 'reconnect' | 'command_palette' | 'other'
  | 'second_inbox';

/**
 * Every value the `entry_point` column takes: the connect-modal openers above,
 * plus `chat_link`, the checkout link in the in-chat Free-cap refusal
 * (app/u/[token]/route.ts).
 *
 * `chat_link` is deliberately NOT in connect-entry-point.mjs. That list is what
 * the browser's beacon is narrowed against, and a link opened from a chat
 * transcript is only ever recorded by the server; leaving it off the browser's
 * list means no client can forge a chat-link row.
 */
export type FunnelEntryPoint = ConnectEntryPoint | 'chat_link' | AppPasswordLinkEntryPoint;

/**
 * On `app_password_link_clicked` rows only: which external link in the
 * onboarding inbox step was opened (APP_PASSWORD_LINKS in activation-events.ts).
 */
export type AppPasswordLinkEntryPoint = 'two_step' | 'app_passwords' | 'imap_setting' | 'account_security' | 'admin_consent';

/** Narrow an untrusted value to the closed list; anything else is null. */
export function connectEntryPoint(value: unknown): ConnectEntryPoint | null {
  return parseConnectEntryPoint(value) as ConnectEntryPoint | null;
}

/**
 * True when an insert failed only because `entry_point` is not a column yet:
 * 42703 is Postgres' undefined_column, PGRST204 is PostgREST not finding the
 * column in its schema cache. Either means the code shipped before
 * 20261005120000_funnel_entry_point.sql was applied.
 */
function entryPointColumnMissing(error: { code?: string; message?: string }): boolean {
  return (error.code === '42703' || error.code === 'PGRST204') && /entry_point/.test(error.message ?? '');
}

/**
 * Persist a server-observed funnel fact. The vocabulary is deliberately small
 * and category-only, so this is useful for product analysis without becoming a
 * second audit log or storing mailbox/credential data.
 */
/** Plan+interval a checkout targeted. Never a Stripe price id or amount. */
export type BillingTargetCategory =
  | 'personal_month' | 'personal_year' | 'solo_month' | 'solo_year' | 'pro_month' | 'pro_year';
/** The plan a user was on when a paywall / portal event fired. */
export type BillingPlanCategory = 'free' | 'personal' | 'solo' | 'pro';
/** Which retention option a `retention_option_clicked` row is about. */
export type RetentionOptionCategory = 'pause' | 'downgrade';
/** Where a signed-in user saw the plans. */
export type PricingSurfaceCategory = 'pricing_page' | 'dashboard_billing';
/**
 * The 3-month Personal pass (20261025010000): the product itself, the surfaces
 * its offer can be shown on, and `pass` for a renewal that bought another pass.
 */
export type PassFunnelCategory =
  | 'personal_pass_3m'
  | 'checkout_return' | 'cap_banner' | 'paywall_email_3' | 'pass_reminder'
  | 'pass';

/** pause_resumed: who ended it. retention_option_clicked: which option. */
export type PlanChangeCategory = 'early' | 'auto' | 'pause' | 'downgrade';

export type ProductFunnelEvent = {
  workspaceId: string;
  stage:
    | 'onboarding_started' | 'client_selected' | 'provider_selected' | 'inbox_connection'
    | 'connection_verified' | 'credential_created' | 'technical_activation' | 'value_activation'
    | 'paywall_reached' | 'pricing_viewed' | 'checkout_started' | 'checkout_completed'
    | 'billing_portal_opened'
    // An EXISTING subscriber's price was swapped in place. Deliberately not
    // `checkout_completed`: that stage is what `billing_funnel_by_workspace`
    // exposes as `paid_at`, which the experiment read-out treats as "this
    // workspace converted", so filing a plan change there would count every
    // downgrade as a new sale. Two stages rather than one `plan_changed`
    // because the direction is the whole point: a bucket that cannot separate
    // expansion from contraction answers neither question.
    | 'plan_upgraded' | 'plan_downgraded'
    // The dashboard invited a business-domain workspace to connect a second
    // work mailbox. outcome `started` = seen, `success` = clicked; at most one
    // of each per workspace (lib/analytics/multi-inbox-prompt.ts).
    | 'multi_inbox_prompt'
    // A buy button on the inbox-cap offer was clicked. The matching "shown" is
    // the `paywall_reached` row with connection_type 'first_connect'.
    | 'paywall_clicked'
    // Activation rescue, written from the dashboard through
    // /api/analytics/activation-event (lib/analytics/activation-events.ts).
    | 'connect_fix_shown' | 'connect_fix_link_clicked'
    | 'first_call_prompt_copied' | 'waiting_state_shown' | 'install_link_clicked'
    | 'first_call_prompt_copied' | 'waiting_state_shown'
    // An external app-password / 2-Step Verification link on the onboarding
    // inbox step (20261026214313). entry_point = which link.
    | 'app_password_link_clicked'
    // Pause and switch to Personal (migration 20261024233000). Category is the
    // plan the customer was on, except pause_resumed (early | auto) and
    // retention_option_clicked (pause | downgrade).
    | 'pause_started' | 'pause_extended' | 'pause_resumed' | 'pause_ended_cancelled'
    | 'downgrade_scheduled' | 'downgrade_undone'
    | 'inbox_parked' | 'inbox_unparked'
    // Why a subscriber cancelled, answered after the cancel was done
    // (/billing/feedback). category = the reason.
    | 'cancel_reason_submitted'
    // A pause or downgrade option was clicked (billing card or post-cancel
    // email). category = 'pause' | 'downgrade'.
    | 'retention_option_clicked'
    // The failed-payment banner's button (/api/stripe/payment-fix). success =
    // sent on to Stripe, failure = bounced to settings.
    | 'payment_fix_clicked'
    // Referral program (20261025090000). `category` is the workspace's plan.
    // `referral_click` has no workspace and is never written here.
    | 'referral_link_viewed' | 'referral_link_copied' | 'referral_attached'
    | 'referral_attach_refused' | 'referral_charged' | 'referral_qualified'
    | 'referral_voided' | 'referral_held' | 'referral_capped'
    // The 3-month Personal pass. A pass NEVER writes `checkout_started` or
    // `checkout_completed`, for the same reason a plan change does not: those
    // stages are the subscription conversion every read-out is built on.
    | 'pass_offer_shown' | 'pass_checkout_started' | 'pass_checkout_completed'
    | 'pass_reminder_sent' | 'pass_expired' | 'pass_refunded' | 'pass_renewed'
    // The /onboarding flow (20261026152301, src/lib/onboarding/). Step views
    // carry the step as category (OnboardingStepCategory); client_changed and
    // onboarding_completed carry the client; onboarding_reset is 'unknown'.
    | 'onboarding_step_viewed' | 'client_changed' | 'onboarding_completed' | 'onboarding_reset'
    // /onboarding sub-states (20261026221917, WP-F): handshake and open-client
    // carry the client, help the tier (help_*), prompt copies the prompt
    // (prompt_*), emailed links the link (link_*), the morning brief opt-in the
    // client and its send 'unknown'.
    | 'onboarding_handshake_seen' | 'onboarding_help_shown' | 'onboarding_prompt_copied'
    | 'onboarding_open_client_clicked' | 'onboarding_link_emailed'
    | 'morning_brief_opt_in' | 'morning_brief_sent'
    // Onboarding Flow B (20261026233917, src/lib/onboarding/flow-b.mjs):
    // second-inbox card and plan summary carry the surface (surface_*) or,
    // for plan_summary_clicked, the plan; the usage meter its level
    // (level_* on the dashboard, chat_* written by mcp-server).
    | 'second_inbox_prompt_shown' | 'second_inbox_prompt_clicked'
    | 'plan_summary_shown' | 'plan_summary_dismissed' | 'plan_summary_clicked'
    | 'usage_meter_shown' | 'grace_end_note_shown'
    // Connector-first consent (20261026232117, src/lib/onboarding/authorize-funnel.ts).
    // At most one of each per workspace; category = the AI app's chip id.
    | 'authorize_signup_redirect' | 'authorize_inbox_step_viewed' | 'authorize_inbox_connected' | 'authorize_skipped';
  outcome: 'started' | 'success' | 'failure';
  category:
    | 'gmail' | 'outlook' | 'fastmail' | 'icloud' | 'yahoo' | 'zoho' | 'yandex' | 'generic_imap'
    | 'aol' | 'gmx' | 'web_de'
    | 'api_key' | 'oauth' | 'claude' | 'chatgpt' | 'cursor' | 'vscode' | 'cline' | 'windsurf'
    | 'gemini' | 'zed' | 'jetbrains' | 'raycast' | 'warp' | 'curl' | 'unknown'
    | BillingTargetCategory | BillingPlanCategory | PricingSurfaceCategory | PassFunnelCategory
    | PlanChangeCategory | CancelReason | RetentionOptionCategory
    | 'claude_code' | OnboardingStepCategory | OnboardingAssistCategory
    | 'surface_onboarding' | 'surface_overview'
    | 'level_50' | 'level_80' | 'level_100' | 'chat_80' | 'chat_100';
  errorCategory?:
    | 'auth_failed' | 'validation_failed' | 'provider_denied' | 'token_exchange_failed'
    | 'plan_limit' | 'conflict' | 'persistence_failed' | 'unknown'
    // Blocked by the provider's own consent policy before the user could
    // answer. Distinct from provider_denied, which is the user saying no.
    | 'consent_required'
    | 'price_not_configured' | 'subscription_exists' | 'stripe_error' | 'no_customer';
  /** Coarse protocol phase only; never a host, address, credential, or response. */
  phase?: string;
  connectionType?: 'first_connect' | 'reconnect';
  /**
   * Which sub-case an `auth_failed` was classified as (lib/email/auth-failure.ts).
   *
   * `auth_failed` is the largest failure bucket on every connector, and on its
   * own it cannot answer the only question worth asking about it: whether the
   * user sent the wrong KIND of secret or simply mistyped the right one. The
   * classification already existed and was already computed on every one of
   * these failures. It was sent to the browser and written to app_errors, and
   * then dropped on the floor here, which is why the connect regression of
   * 2026-09-08 had to be diagnosed from the shape of the code instead of from
   * the rows.
   *
   * An enum member, never free text: no host, address or credential.
   */
  authReason?: AuthFailureReason | null;
  /**
   * Which control opened the connect modal, on the rows the modal writes
   * (`paywall_reached` from the inbox cap, `provider_selected`). Null on every
   * other row, and for a value the server did not recognise.
   */
  entryPoint?: FunnelEntryPoint | null;
};

export async function recordProductFunnelEvent(db: Db, event: ProductFunnelEvent): Promise<void> {
  const table = db.from('product_funnel_events');
  const row = {
    workspace_id: event.workspaceId,
    stage: event.stage,
    outcome: event.outcome,
    category: event.category,
    error_category: event.errorCategory ?? null,
    phase: safeDiagnosticPhase(event.phase),
    connection_type: event.connectionType ?? null,
    auth_reason: event.authReason ?? null,
  };
  // The column is only named when there is something to put in it, so every
  // row that has no entry point is the insert it has always been.
  let { error } = event.entryPoint
    ? await table.insert({ ...row, entry_point: event.entryPoint })
    : await table.insert(row);
  // Deployed ahead of the migration: keep the funnel row and drop only the new
  // attribute. Losing `paywall_reached` rows for the length of a release would
  // cost far more than a few rows with no entry point on them.
  if (error && event.entryPoint && entryPointColumnMissing(error)) {
    console.error('[product-funnel] entry_point column missing; row recorded without it', { stage: event.stage });
    ({ error } = await table.insert(row));
  }
  if (error) {
    console.error('[product-funnel] event insert failed', { stage: event.stage, outcome: event.outcome, error: error.message });
    return;
  }

  if (event.outcome !== 'success') return;
  const now = new Date().toISOString();
  const marker = event.stage === 'inbox_connection'
    ? { analytics_first_inbox_connected_at: now, analytics_first_inbox_provider: event.category, onboarding_inbox_connected_at: now, onboarding_provider: event.category, onboarding_stage: 'inbox_connected' }
    : event.stage === 'credential_created'
      ? { analytics_first_credential_created_at: now, analytics_first_credential_method: event.category, onboarding_credential_issued_at: now, onboarding_stage: 'credential_issued' }
      : null;
  const markerColumn = event.stage === 'inbox_connection'
    ? 'analytics_first_inbox_connected_at'
    : event.stage === 'credential_created' ? 'analytics_first_credential_created_at' : null;
  if (!marker || !markerColumn) return;
  const { error: markerError } = await db.from('workspaces').update(marker).eq('id', event.workspaceId).is(markerColumn, null);
  if (markerError) console.error('[product-funnel] marker update failed', { stage: event.stage, error: markerError.message });
}

/** Record an OAuth callback failure using only its unguessable, single-use state. */
export async function recordOAuthCallbackFailure(
  db: Db,
  state: string | null,
  provider: 'gmail' | 'outlook',
  errorCategory: 'provider_denied' | 'consent_required' | 'unknown'
): Promise<void> {
  if (!state) return;
  const states = db.from('oauth_states');
  const { data } = await states.select('id, workspace_id').eq('state', state).eq('provider', provider).maybeSingle();
  if (!data?.workspace_id) return;
  await recordProductFunnelEvent(db, { workspaceId: data.workspace_id, stage: 'inbox_connection', outcome: 'failure', category: provider, errorCategory, phase: 'authorization' });
  // A denial/error terminally consumes the state just like a successful callback.
  await states.delete().eq('id', data.id);
}
