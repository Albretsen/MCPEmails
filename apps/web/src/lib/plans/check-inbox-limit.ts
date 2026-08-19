import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { planDisplayName, resolvePlanLimits } from '@/lib/stripe/plans';

/**
 * Result of an inbox cap check.
 */
export interface InboxLimitCheckResult {
  /** True when the workspace has reached the plan's inbox cap. */
  atLimit: boolean;
  /**
   * The workspace's effective INTERNAL plan slug ("free" | "solo" | "pro").
   * Never render this: the ids and the names customers see diverged in the
   * 2026-08-19 repricing (solo is sold as Pro, pro as Team). Use `planName`.
   */
  plan: string;
  /** Customer-facing plan name ("Free" | "Pro" | "Team"). Safe to render. */
  planName: string;
  /** Number of active (non-deleted) inboxes currently connected. */
  currentCount: number;
  /**
   * The plan's inbox cap. `null` means unlimited (a paid plan, or a
   * grandfathered user).
   * Used in UI copy: "1 of 5 inboxes".
   */
  maxInboxes: number | null;
  /**
   * True when the cap does not apply because this user pre-dates the
   * 2026-08-19 repricing and was grandfathered into unlimited inboxes.
   * Surfaced so a support question about "why is this account not capped"
   * has an answer that is not a guess.
   */
  unlimitedInboxes: boolean;
}

/**
 * Check whether a workspace has reached its plan inbox cap.
 *
 * Runs two parallel queries:
 *   1. Fetch the workspace's current plan.
 *   2. Count active (non-deleted) inboxes for the workspace.
 *
 * Returns `{ atLimit: false, ... }` when the workspace can still connect
 * more inboxes, or `{ atLimit: true, ... }` when the plan cap is reached.
 *
 * @param supabase  A request-scoped Supabase client (user or service role).
 * @param workspaceId  The workspace UUID to check.
 *
 * @example
 * const result = await checkInboxLimit(supabase, workspaceId);
 * if (result.atLimit) {
 *   return NextResponse.redirect(`...?error=inbox_limit_reached`);
 * }
 */
export async function checkInboxLimit(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
): Promise<InboxLimitCheckResult> {
  // Run both queries in parallel to minimise latency.
  const [effectivePlanResult, inboxCountResult] = await Promise.all([
    supabase
      .rpc('effective_workspace_plan', { p_workspace_id: workspaceId }),
    supabase
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null),
  ]);

  const effectivePlan = effectivePlanResult.data?.[0];
  const plan = effectivePlan?.plan ?? 'free';
  const unlimitedInboxes = effectivePlan?.unlimited_inboxes ?? false;
  const limits = resolvePlanLimits(plan, {
    compedScale: effectivePlan?.comped_scale ?? false,
    unlimitedInboxes,
  });
  const currentCount = inboxCountResult.count ?? 0;

  // Infinity: a paid plan, a comped grant, or a grandfathered user.
  if (limits.maxInboxes === Infinity) {
    return {
      atLimit: false,
      plan,
      planName: planDisplayName(plan),
      currentCount,
      maxInboxes: null,
      unlimitedInboxes,
    };
  }

  return {
    atLimit: currentCount >= limits.maxInboxes,
    plan,
    planName: planDisplayName(plan),
    currentCount,
    maxInboxes: limits.maxInboxes,
    unlimitedInboxes,
  };
}

/**
 * Whether the workspace already has a (non-deleted) inbox for this email.
 *
 * Used to distinguish a reconnect (same address, where the upsert reuses the
 * existing row and does not increase the inbox count) from a brand-new
 * connection. Reconnects must never be blocked by the plan inbox cap.
 *
 * This matters far more since the 2026-08-19 repricing than it did before it.
 * Free is one inbox now, so a new free user is AT the cap the moment their
 * first mailbox is connected, and every subsequent credential refresh for that
 * same mailbox arrives while `currentCount >= maxInboxes`. Without this exemption
 * a rotated app password would lock the user out of their own inbox. The cap
 * counts inboxes, not connection attempts, and a reconnect adds no inbox.
 */
export async function inboxExistsForEmail(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  email: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('inboxes')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('email_address', email)
    .is('deleted_at', null)
    .maybeSingle();

  return !!data;
}

/**
 * The body of the 402 returned when a brand-new inbox would exceed the cap.
 *
 * Shared by all three JSON connect routes (generic IMAP, app-password,
 * Fastmail) so the three cannot drift. The OAuth callbacks redirect instead of
 * returning JSON, so they carry only `?error=inbox_limit_reached`.
 *
 * The sentence in `error` is deliberately minimal and unlocalised: it is a
 * fallback for a non-browser client, not the copy a user is meant to read. The
 * dashboard localises off `error_code` and formats the numbers itself. The old
 * sentence interpolated `plan`, which is an INTERNAL slug, so free users were
 * told about their "solo plan" and paying ones about their "pro plan".
 */
export interface InboxLimitErrorBody {
  error: string;
  error_code: 'inbox_limit_reached';
  /** Internal plan slug. For logs and support, not for display. */
  plan: string;
  /** Customer-facing plan name: "Free" | "Pro" | "Team". */
  plan_name: string;
  /** Inboxes already connected. */
  current_count: number;
  /** The cap that was hit. Never null here: an uncapped plan cannot reach this. */
  max_inboxes: number;
  /** Where the client should send the user. */
  upgrade_url: string;
}

export function inboxLimitErrorBody(result: InboxLimitCheckResult): InboxLimitErrorBody {
  const max = result.maxInboxes ?? 0;
  return {
    error: max === 1
      ? 'Inbox limit reached: this plan includes 1 connected inbox.'
      : `Inbox limit reached: this plan includes ${max} connected inboxes.`,
    error_code: 'inbox_limit_reached',
    plan: result.plan,
    plan_name: result.planName,
    current_count: result.currentCount,
    max_inboxes: max,
    upgrade_url: '/pricing',
  };
}
