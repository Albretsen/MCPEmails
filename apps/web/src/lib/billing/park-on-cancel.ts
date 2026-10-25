/**
 * Decision D3: when a cancelled paid plan ends, the inboxes above Free's cap
 * are parked (Documents/plans/pause-downgrade-20261024.md, sections 2.4 and
 * 11). Parked, not deleted: parking.ts keeps the credentials, and the upgrade
 * path (syncPlanChange in the Stripe webhook) unparks on any later paid plan.
 *
 * NOT RETROACTIVE. Only a subscription whose cancellation the webhook saw
 * scheduled while BILLING_PARK_ON_CANCEL_ENABLED was on (or for an internal
 * account) is affected. That moment is recorded on user_billing
 * (`park_on_end_subscription_id`, `park_on_end_marked_at`, migration
 * 20261025020000) the first time the webhook sees `cancellationAction() ===
 * 'queue'` with the flag on. The cancel confirmation email is queued in the
 * same handler, after the mark, so the sentence about parking goes exactly to
 * the customers whose plan end will park.
 *
 *   Undo (renew before the end)       the marker is cleared.
 *   Flag turned off later             nothing new is marked; a subscription
 *                                     already marked still parks, because its
 *                                     email said so. Clear the column to stop
 *                                     one by hand.
 *   Dunning end (card retries run out, Stripe deletes the subscription)
 *                                     NEVER parks without the marker. A
 *                                     subscription that passed through no
 *                                     scheduled cancel was never told, and a
 *                                     failed card is not a decision to leave.
 *                                     With the marker (they cancelled, then a
 *                                     payment failed before the end) it parks
 *                                     like any other end of that subscription.
 *   Immediate cancel (dashboard)      no scheduled state, no marker, no park.
 *
 * The marker names the subscription, so an older subscription's marker never
 * matches a newer one, and a resubscribe needs no clean-up.
 *
 * THE COLUMNS AND THE GENERATED TYPES. Like plan-change-sync.ts: the committed
 * types come from production, where 20261025020000 is not applied yet, while
 * CI also type-checks against a freshly migrated database. The two columns are
 * reached through one narrow facade, cast once, which compiles against both.
 * Before the migration is applied every read here fails with an unknown
 * column, which is treated as "no marker": nothing parks and nothing breaks.
 *
 * NOTHING HERE THROWS. Every caller sits beside a plan write in the Stripe
 * webhook, which answers 500 on a throw; parking must never cost Stripe its
 * 200.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { isUnknownColumnError } from '@/lib/approvals/columns';
import { parkOnCancelEnabledFor, parkOnCancelFlagOn } from '@/lib/billing/plan-change-flags';
import { largestInboxCountAboveCap, parkOwner, sanitizeKeepOrder } from '@/lib/billing/plan-change-sync';

type Db = SupabaseClient<Database>;
type DbError = { message: string; code?: string } | null;

export interface ParkMarkerRow {
  park_on_end_subscription_id: string | null;
  park_on_end_marked_at: string | null;
  inbox_keep_order: unknown;
}

interface MarkerPatch {
  park_on_end_subscription_id: string | null;
  park_on_end_marked_at: string | null;
}

interface FilterChain extends PromiseLike<{ error: DbError }> {
  eq(column: 'user_id' | 'park_on_end_subscription_id', value: string): FilterChain;
}

/** The one place the two columns are typed (see the module note). */
interface ParkMarkerTable {
  select(columns: string): {
    eq(column: 'user_id', value: string): {
      maybeSingle(): PromiseLike<{ data: ParkMarkerRow | null; error: DbError }>;
    };
  };
  update(patch: MarkerPatch): FilterChain;
}

function markerTable(db: Db): ParkMarkerTable {
  return db.from('user_billing') as unknown as ParkMarkerTable;
}

/** The owner's marker and keep order, or null when it cannot be read (including before the migration). */
export async function readParkMarker(db: Db, userId: string): Promise<ParkMarkerRow | null> {
  try {
    const { data, error } = await markerTable(db)
      .select('park_on_end_subscription_id, park_on_end_marked_at, inbox_keep_order')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      if (!isUnknownColumnError(error)) console.error(`[park-on-cancel] marker read failed: ${error.message}`);
      return null;
    }
    return data;
  } catch (err) {
    console.error('[park-on-cancel] marker read threw, swallowed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function writeMarker(db: Db, userId: string, patch: MarkerPatch, onlySubscriptionId?: string): Promise<boolean> {
  try {
    let query = markerTable(db).update(patch).eq('user_id', userId);
    if (onlySubscriptionId) query = query.eq('park_on_end_subscription_id', onlySubscriptionId);
    const { error } = await query;
    if (error) {
      if (!isUnknownColumnError(error)) console.error(`[park-on-cancel] marker write failed: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[park-on-cancel] marker write threw, swallowed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface MarkerSyncInput {
  db: Db;
  ownerId: string;
  subscriptionId: string;
  cancellation: 'queue' | 'cancel_open';
  /** Looked up only when the flag is off, for the internal-account check. */
  email: () => Promise<string | null>;
  now?: Date;
}

/**
 * Keep the marker in step with a subscription event. Returns true when this
 * subscription's end will park inboxes (marked now or earlier).
 *
 *   'queue'        mark it, if the flag is on for the owner and it is not
 *                  marked yet. An already marked subscription stays marked
 *                  whatever the flag says now.
 *   'cancel_open'  clear a marker on THIS subscription (the cancel was undone).
 */
export async function syncParkMarker(input: MarkerSyncInput): Promise<boolean> {
  try {
    const row = await readParkMarker(input.db, input.ownerId);
    if (!row) return false;
    const marked = row.park_on_end_subscription_id === input.subscriptionId;

    if (input.cancellation === 'cancel_open') {
      if (marked) {
        await writeMarker(
          input.db,
          input.ownerId,
          { park_on_end_subscription_id: null, park_on_end_marked_at: null },
          input.subscriptionId,
        );
      }
      return false;
    }

    if (marked) return true;
    const enabled = parkOnCancelFlagOn() || parkOnCancelEnabledFor(await input.email());
    if (!enabled) return false;
    return await writeMarker(input.db, input.ownerId, {
      park_on_end_subscription_id: input.subscriptionId,
      park_on_end_marked_at: (input.now ?? new Date()).toISOString(),
    });
  } catch (err) {
    console.error('[park-on-cancel] marker sync failed, swallowed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * For the cancel email: the largest number of active inboxes in one of the
 * owner's workspaces that Free's cap would park, or 0 (nothing to park, the
 * owner is grandfathered or comped, or the read failed). Never throws.
 */
export async function parkInboxCountForEmail(db: Db, ownerId: string): Promise<number> {
  try {
    return await largestInboxCountAboveCap(db, ownerId, 'free');
  } catch {
    return 0;
  }
}

/**
 * The subscription ended (deleted, or projected to Free as canceled). Park the
 * owner's inboxes above Free's cap when, and only when, this subscription is
 * the marked one; the customer's stored order first, then the most used.
 * Clears the marker once parking succeeded, so a failure is retried by the
 * next end event (an updated to canceled is followed by the deleted).
 * Returns the number of inboxes parked. Never throws.
 */
export async function parkOnSubscriptionEnd(
  db: Db,
  ownerId: string,
  subscriptionId: string,
  label: string,
): Promise<number> {
  try {
    const row = await readParkMarker(db, ownerId);
    if (!row || row.park_on_end_subscription_id !== subscriptionId) return 0;
    const keepOrder = sanitizeKeepOrder(row.inbox_keep_order);
    const result = await parkOwner(db, ownerId, 'free', keepOrder, label);
    if (!result.failed) {
      await writeMarker(db, ownerId, { park_on_end_subscription_id: null, park_on_end_marked_at: null }, subscriptionId);
    }
    return result.parked;
  } catch (err) {
    console.error('[park-on-cancel] park on end failed, swallowed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}
