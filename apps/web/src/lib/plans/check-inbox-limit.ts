import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { planDisplayName, resolvePlanLimits } from '@/lib/stripe/plans';
import { inboxCapOffer } from '@/lib/billing/inbox-cap-offer.mjs';
import { pricingCompareHref } from '@/lib/billing/upgrade-intent.mjs';
import { isUnknownColumnError } from '@/lib/approvals/columns';

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
  /** Customer-facing plan name ("Free" | "Personal" | "Pro" | "Business"). Safe to render. */
  planName: string;
  /**
   * Number of inboxes currently connected and usable: not deleted and not
   * parked. A parked inbox (parked above a lower plan's cap, see
   * src/lib/billing/parking.ts) does not hold a slot, so it never blocks the
   * customer from connecting the one inbox their plan does include.
   */
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
  /**
   * True when a Pro workspace is uncapped by the 2026-10 cutover exemption
   * (`workspaces.pro_unlimited_inboxes_exempt`) or because the Pro cap's kill
   * switch is off. Returned for every plan; only `solo` acts on it.
   */
  proUnlimitedInboxes: boolean;
  /**
   * True while a Free workspace's owner holds an earned referral month. The
   * workspace is then checked, and reported, as Personal: `plan` is
   * "personal" here even though `workspaces.plan` is still "free". When the
   * month ends the extra inboxes pause through plan-limit-pauses.ts.
   */
  referralPersonal: boolean;
}

/**
 * Check whether a workspace has reached its plan inbox cap.
 *
 * Runs two parallel queries:
 *   1. Fetch the workspace's current plan.
 *   2. Count active inboxes for the workspace: not deleted, not parked.
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
  const countActive = (excludeParked: boolean) => {
    const query = supabase
      .from('inboxes')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null);
    return excludeParked ? query.is('parked_at', null) : query;
  };
  const [effectivePlanResult, firstCount] = await Promise.all([
    supabase
      .rpc('effective_workspace_plan', { p_workspace_id: workspaceId }),
    countActive(true),
  ]);
  // Before migration 20261024173000 is applied the column does not exist and
  // PostgREST refuses the filter. A null count would read as 0 and open the
  // gate, so count the way this did before parking existed instead.
  const inboxCountResult = firstCount.error && isUnknownColumnError(firstCount.error)
    ? await countActive(false)
    : firstCount;

  const effectivePlan = effectivePlanResult.data?.[0];
  const storedPlan = effectivePlan?.plan ?? 'free';
  // Absent on an RPC that predates 20261025090000: no referral month.
  const referralPersonal = storedPlan === 'free' && (effectivePlan?.referral_personal ?? false);
  const plan = referralPersonal ? 'personal' : storedPlan;
  const unlimitedInboxes = effectivePlan?.unlimited_inboxes ?? false;
  const proUnlimitedInboxes = effectivePlan?.pro_unlimited_inboxes ?? false;
  const limits = resolvePlanLimits(plan, {
    compedScale: effectivePlan?.comped_scale ?? false,
    unlimitedInboxes,
    proUnlimitedInboxes,
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
      proUnlimitedInboxes,
      referralPersonal,
    };
  }

  return {
    atLimit: currentCount >= limits.maxInboxes,
    plan,
    planName: planDisplayName(plan),
    currentCount,
    maxInboxes: limits.maxInboxes,
    unlimitedInboxes,
    proUnlimitedInboxes,
    referralPersonal,
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
  /** Customer-facing plan name: "Free" | "Personal" | "Pro" | "Business". */
  plan_name: string;
  /** Inboxes already connected. */
  current_count: number;
  /** The cap that was hit. Never null here: an uncapped plan cannot reach this. */
  max_inboxes: number;
  /**
   * Where the client should send the user.
   *
   * Carries the offer: `/pricing?plan=<id>&interval=month`. It used to be the
   * bare constant '/pricing', which threw away the one thing this response
   * knows that the pricing page does not, namely which plan actually clears the
   * cap that was just hit.
   */
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
    // Same rule as both paywall surfaces, from the same module: the cheapest
    // plan that clears the cap that was hit. Keyed off `max`, the number this
    // very check just counted, so the link cannot quote a plan the refusal
    // does not justify.
    //
    // MONTHLY, matching the paywall panel's own deliberate default. /pricing
    // preselects annual, so an unparameterised link answers a "$5 a month"
    // refusal with a "$4 a month, billed $48/year" card: the same plan at a
    // different number, which is a decision the buyer has to make twice.
    // Defaulting this to year would silently turn a $5 intent into a $48 one.
    upgrade_url: pricingCompareHref(inboxCapOffer(max).plan, false),
  };
}
