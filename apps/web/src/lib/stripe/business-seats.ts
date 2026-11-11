import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import {
  basePlanItem,
  businessSeatQuantity,
  isBusinessSeatPriceId,
} from '@/lib/stripe/plans';

/**
 * Business billed per person: who counts, and keeping the Stripe quantity in
 * step with them. Read mailbox-addon.ts first; this mirrors it.
 *
 * THE SWITCH. `pricing_switches.business_seat_pricing`. Off (the default, and
 * production until it is flipped), nothing here does anything: checkout sells
 * the flat Business price, and `syncBusinessSeats` returns `switch_off`
 * before it reads anything else. A read that fails counts as off.
 *
 * WHO IS BILLABLE for a Business subscription owned by user U: the distinct
 * users among U, plus every member with role `admin` or `member` of a
 * non-deleted workspace U owns who owns at least one non-deleted mailbox in
 * that same workspace (`inboxes.owner_user_id`). Viewers never count. An admin
 * with no mailbox of their own is free. A person in two of U's workspaces is
 * one person. Stripe quantity = max(BUSINESS_MIN_SEATS, billable people).
 *
 * WHICH SUBSCRIPTIONS. Only one whose base item is on a seat price
 * (STRIPE_PRICE_BUSINESS_SEAT_*). The flat $39 Business, the founder price and
 * the retired Team prices are never touched: their quantity stays 1.
 *
 * WHEN IT RUNS. After someone joins (invite accept), leaves or is removed,
 * after a role change, after a mailbox is connected or deleted (through
 * syncMailboxAddonForWorkspace, which every connect and delete route already
 * calls), after a workspace is deleted, and on every Business subscription
 * webhook. Every run reads the live state and sets an absolute quantity, so a
 * repeat, a retry or two runs out of order converge on the same answer. A run
 * re-counts after it writes and writes once more if the count moved while it
 * was talking to Stripe, so two events a second apart cannot leave the
 * slower one's stale count behind.
 *
 * ADDING a person bills now: `always_invoice` invoices the prorated rest of
 * the period at once, the rule checkout-core and the mailbox add-on use.
 *
 * REMOVING a person credits the unused rest of the period:
 * `create_prorations`, so the credit lands on the next invoice. This differs
 * from the add-on on purpose. A person is $19 a month or $182.40 a year, and
 * an annual customer who removes someone in month two would otherwise pay for
 * ten months of a person who is gone. Prorating both ways also makes a remove
 * followed by a re-add cost nothing extra: the credit and the new charge cover
 * the same days.
 *
 * NEVER BLOCKS. The membership or mailbox change has already happened. A
 * failure is logged and returned, never thrown, and the next run repairs it.
 */

export const BUSINESS_SEAT_SWITCH_KEY = 'business_seat_pricing';

type Db = SupabaseClient<Database>;

/** Roles that become billable once they own a mailbox. */
const BILLABLE_ROLES = new Set(['admin', 'member']);

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

const SWITCH_TTL_MS = 60_000;
let switchCache: { value: boolean; at: number } | null = null;

/** Test seam: forget the cached switch. */
export function resetBusinessSeatSwitchCache(): void {
  switchCache = null;
}

/**
 * Whether per-person Business is on. Cached 60 s per server instance, like
 * the founder flag. Fails CLOSED: an error reads as off, which is exactly
 * production's behaviour today. `fresh` skips the cache (checkout pricing).
 */
export async function businessSeatPricingOn(opts?: {
  db?: Db;
  fresh?: boolean;
  now?: number;
}): Promise<boolean> {
  const now = opts?.now ?? Date.now();
  if (!opts?.fresh && switchCache && now - switchCache.at < SWITCH_TTL_MS) return switchCache.value;
  try {
    const db = opts?.db ?? (await import('@/lib/supabase/service')).createServiceRoleClient();
    const { data, error } = await db
      .from('pricing_switches')
      .select('enabled')
      .eq('key', BUSINESS_SEAT_SWITCH_KEY)
      .maybeSingle();
    if (error) {
      console.error('[business-seats] switch read failed', { error: error.message });
      return false;
    }
    const value = data?.enabled === true;
    switchCache = { value, at: now };
    return value;
  } catch (err) {
    console.error(
      '[business-seats] switch read failed',
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

export interface SeatMemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
}

export interface SeatInboxRow {
  workspace_id: string;
  owner_user_id: string | null;
}

/**
 * Billable people, from the rows of the owner's workspaces. Pure.
 *
 * `members` and `inboxes` must already be limited to the owner's non-deleted
 * workspaces and to non-deleted mailboxes. The owner always counts, whether
 * or not they have a mailbox and whatever their membership row says.
 */
export function billablePeopleFrom(input: {
  ownerId: string;
  members: readonly SeatMemberRow[];
  inboxes: readonly SeatInboxRow[];
}): number {
  const ownsInboxIn = new Set<string>();
  for (const inbox of input.inboxes) {
    if (inbox.owner_user_id) ownsInboxIn.add(`${inbox.workspace_id}:${inbox.owner_user_id}`);
  }
  const people = new Set<string>([input.ownerId]);
  for (const member of input.members) {
    if (!BILLABLE_ROLES.has(member.role)) continue;
    if (ownsInboxIn.has(`${member.workspace_id}:${member.user_id}`)) people.add(member.user_id);
  }
  return people.size;
}

/** Non-deleted workspaces the user owns. Null when the read failed. */
async function ownedWorkspaceIds(db: Db, ownerId: string): Promise<string[] | null> {
  const { data, error } = await db
    .from('workspaces')
    .select('id')
    .eq('owner_id', ownerId)
    .is('deleted_at', null);
  if (error) {
    console.error('[business-seats] workspace lookup failed', { error: error.message });
    return null;
  }
  return (data ?? []).map((w) => w.id);
}

const PAGE = 1000;

/** Every page of a select, in a total order (PostgREST stops at 1000 rows). */
async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) {
      console.error('[business-seats] read failed', { error: error.message });
      return null;
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * The mailbox owners in these workspaces, one row per non-deleted inbox.
 * Kept in one function: it is the only read of `inboxes.owner_user_id`.
 */
async function readInboxOwners(db: Db, workspaceIds: string[]): Promise<SeatInboxRow[] | null> {
  return readAllPages<SeatInboxRow>((from, to) =>
    db
      .from('inboxes')
      .select('id, workspace_id, owner_user_id')
      .in('workspace_id', workspaceIds)
      .is('deleted_at', null)
      .not('owner_user_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
}

/** Billable people for the subscription owner. Null when a read failed. */
export async function countBillablePeople(db: Db, ownerId: string): Promise<number | null> {
  const ids = await ownedWorkspaceIds(db, ownerId);
  if (ids === null) return null;
  if (ids.length === 0) return 1;

  const [members, inboxes] = await Promise.all([
    readAllPages<SeatMemberRow>((from, to) =>
      db
        .from('workspace_members')
        .select('workspace_id, user_id, role')
        .in('workspace_id', ids)
        .in('role', [...BILLABLE_ROLES])
        .order('workspace_id', { ascending: true })
        .order('user_id', { ascending: true })
        .range(from, to),
    ),
    readInboxOwners(db, ids),
  ]);
  if (members === null || inboxes === null) return null;
  return billablePeopleFrom({ ownerId, members, inboxes });
}

/**
 * Company-wide mailboxes across every workspace the owner owns: what the
 * mailbox add-on counts on a per-person subscription (private mailboxes are
 * covered by their owner's seat). Null when a read failed.
 */
export async function countCompanyInboxes(db: Db, ownerId: string): Promise<number | null> {
  const ids = await ownedWorkspaceIds(db, ownerId);
  if (ids === null) return null;
  if (ids.length === 0) return 0;
  const { count, error } = await db
    .from('inboxes')
    .select('id', { count: 'exact', head: true })
    .in('workspace_id', ids)
    .is('deleted_at', null)
    .eq('visibility', 'company');
  if (error) {
    console.error('[business-seats] company inbox count failed', { error: error.message });
    return null;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export type BusinessSeatSyncResult =
  | {
      status: 'skipped';
      reason:
        | 'switch_off'
        | 'no_owner'
        | 'not_business'
        | 'no_subscription'
        | 'not_entitled'
        | 'not_seat_price'
        | 'pending_update'
        | 'paused'
        | 'count_failed';
    }
  | { status: 'unchanged'; quantity: number }
  | { status: 'updated'; from: number; to: number }
  | { status: 'failed'; reason: string };

const ENTITLED = new Set(['active', 'trialing', 'past_due', 'unpaid']);

/** At most this many writes per run; each re-reads the count first. */
const MAX_PASSES = 3;

export interface BusinessSeatDeps {
  db: Db;
  stripe: Pick<Stripe, 'subscriptions'>;
  /** Overrides the switch read (tests). */
  switchOn?: boolean;
}

/**
 * The proration rule for a quantity change. Pure.
 * More people: invoice the prorated rest now. Fewer: credit it on the next
 * invoice. Same: nothing to send.
 */
export function seatProrationBehavior(
  from: number,
  to: number,
): 'always_invoice' | 'create_prorations' | null {
  if (to === from) return null;
  return to > from ? 'always_invoice' : 'create_prorations';
}

/** Sync the seat quantity for the user who owns `workspaceId`. Never throws. */
export async function syncBusinessSeatsForWorkspace(
  workspaceId: string,
  deps?: Partial<BusinessSeatDeps>,
): Promise<BusinessSeatSyncResult> {
  try {
    const resolved = await resolveDeps(deps);
    if (!(await switchIsOn(resolved))) return { status: 'skipped', reason: 'switch_off' };
    const { data, error } = await resolved.db
      .from('workspaces')
      .select('owner_id')
      .eq('id', workspaceId)
      .maybeSingle();
    if (error || !data?.owner_id) return { status: 'skipped', reason: 'no_owner' };
    return await syncBusinessSeats(data.owner_id, { ...resolved, switchOn: true });
  } catch (err) {
    return failed(err);
  }
}

/**
 * Set the seat quantity of `ownerUserId`'s Business subscription to
 * max(2, billable people). Idempotent, safe to call twice or concurrently, a
 * no-op with the switch off or on any base price that is not a seat price.
 * Never throws.
 */
export async function syncBusinessSeats(
  ownerUserId: string,
  deps?: Partial<BusinessSeatDeps>,
): Promise<BusinessSeatSyncResult> {
  try {
    const resolved = await resolveDeps(deps);
    if (!(await switchIsOn(resolved))) return { status: 'skipped', reason: 'switch_off' };
    const { db, stripe } = resolved;

    // Cheap exit: only a Business subscriber has anything to sync.
    const { data: billing } = await db
      .from('user_billing')
      .select('plan, stripe_subscription_id')
      .eq('user_id', ownerUserId)
      .maybeSingle();
    if (!billing || billing.plan !== 'pro') return { status: 'skipped', reason: 'not_business' };
    if (!billing.stripe_subscription_id) return { status: 'skipped', reason: 'no_subscription' };

    let first: number | null = null;
    let last: number | null = null;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      // The live subscription decides, not user_billing: a plan change in
      // flight must not be billed for the plan it is leaving.
      const subscription = await stripe.subscriptions.retrieve(billing.stripe_subscription_id);
      if (!ENTITLED.has(subscription.status)) return { status: 'skipped', reason: 'not_entitled' };
      const base = basePlanItem(subscription.items?.data);
      if (!base || !isBusinessSeatPriceId(base.price?.id ?? null)) {
        return { status: 'skipped', reason: 'not_seat_price' };
      }
      // A plan change held for payment: Stripe applies it by itself once
      // paid, and its webhook runs this again then.
      if (subscription.pending_update) return { status: 'skipped', reason: 'pending_update' };
      // Paused: the workspace is on Free until it resumes (plan-change-sync),
      // so nobody is billed for people meanwhile. The resume webhook re-runs.
      if (subscription.pause_collection?.behavior) return { status: 'skipped', reason: 'paused' };

      const people = await countBillablePeople(db, ownerUserId);
      if (people === null) return { status: 'skipped', reason: 'count_failed' };
      const target = businessSeatQuantity(people);
      const current = base.quantity ?? 1;
      if (first === null) first = current;

      const proration = seatProrationBehavior(current, target);
      if (proration === null) {
        if (last === null) return { status: 'unchanged', quantity: target };
        break;
      }
      // Quantities are absolute, so no idempotency key: a repeat of the same
      // write is a no-op at Stripe, and a key reused for a later identical
      // change (3 -> 2 -> 3) would replay the first and bill nothing.
      await stripe.subscriptions.update(subscription.id, {
        items: [{ id: base.id, quantity: target }],
        proration_behavior: proration,
      });
      console.log('[business-seats] quantity synced', {
        subscription: subscription.id,
        from: current,
        to: target,
      });
      last = target;
    }
    if (last === null || first === null) return failed(new Error('seat_sync_did_not_settle'));
    return { status: 'updated', from: first, to: last };
  } catch (err) {
    return failed(err);
  }
}

async function switchIsOn(deps: BusinessSeatDeps): Promise<boolean> {
  if (typeof deps.switchOn === 'boolean') return deps.switchOn;
  return businessSeatPricingOn({ db: deps.db });
}

function failed(err: unknown): BusinessSeatSyncResult {
  const reason = err instanceof Error ? err.message : String(err);
  console.error('[business-seats] sync failed', { error: reason });
  return { status: 'failed', reason };
}

async function resolveDeps(deps?: Partial<BusinessSeatDeps>): Promise<BusinessSeatDeps> {
  // Imported lazily so a caller that injects both never loads the real
  // clients, which throw at import time without their environment.
  const db = deps?.db ?? (await import('@/lib/supabase/service')).createServiceRoleClient();
  const stripe = deps?.stripe ?? (await import('@/lib/stripe/client')).stripe;
  return { db, stripe, ...(typeof deps?.switchOn === 'boolean' ? { switchOn: deps.switchOn } : {}) };
}
