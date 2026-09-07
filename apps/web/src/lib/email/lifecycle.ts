/**
 * Shared plumbing for LIFECYCLE email: the non-transactional kind.
 *
 * WHAT COUNTS AS LIFECYCLE. A receipt, an invite, a password reset and a
 * security notice are transactional: the person asked for them by doing
 * something, and they must send whatever anyone's preferences say. Everything
 * else, including a win-back to somebody who has already left, is lifecycle. It
 * is marketing-adjacent, it needs a working one-click opt-out, and it must
 * check that opt-out before every single send.
 *
 * Nothing in this file may be imported by the purchase-confirmation or invite
 * paths. Those two must never learn how to be suppressed.
 *
 * WHAT THIS FILE USED TO CONTAIN. A send ledger (`claimSend` / `finaliseSend`
 * against `lifecycle_email_sends`) and a Resend sender, built on 2026-09-02 for
 * a "personal ask" founder campaign that was dropped on 2026-09-07. Nothing
 * ever called them: the billing lifecycle emails carry their own sender in
 * billing-lifecycle.ts, and their idempotency comes from the unique index on
 * `billing_email_sends` rather than from a second ledger. They were removed
 * rather than left in place, because unused send machinery next to live send
 * machinery is a thing somebody reaches for by mistake. The
 * `lifecycle_email_sends` table is still there, empty, for whenever a real
 * campaign needs it.
 *
 * ENVIRONMENT, all read at call time and never at module load:
 *   LIFECYCLE_EMAIL_FROM  The win-back sender. Deliberately a different address
 *                         from the transactional one.
 *                         Default: Asgeir Albretsen <asgeir@mcpemails.com>,
 *                         which is a real mailbox on the account.
 *   NEXT_PUBLIC_APP_URL   Base URL for links.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Mirrors the CHECK constraint on `users.unsubscribed_categories`. Adding one
 * here without adding it to the constraint means the opt-out silently fails to
 * store, so the two lists are kept adjacent on purpose.
 */
export const LIFECYCLE_CATEGORIES = ['lifecycle', 'product_update', 'research'] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

export function isLifecycleCategory(value: string): value is LifecycleCategory {
  return (LIFECYCLE_CATEGORIES as readonly string[]).includes(value);
}

const DEFAULT_APP_URL = 'https://mcpemails.com';
const DEFAULT_FROM = 'Asgeir Albretsen <asgeir@mcpemails.com>';

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, '');
}

export function lifecycleFrom(): string {
  return process.env.LIFECYCLE_EMAIL_FROM ?? DEFAULT_FROM;
}

/**
 * The opt-out URL for one person.
 *
 * The token is a random uuid stored on the user row, never the user id: a link
 * that leaks out of a forwarded email must not also disclose a primary key, and
 * it must not be guessable from an address someone already knows.
 */
export function unsubscribeUrl(token: string, category: LifecycleCategory): string {
  return `${appUrl()}/api/email/unsubscribe?token=${encodeURIComponent(token)}&c=${encodeURIComponent(category)}`;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Has this person asked us not to send this kind of email?
 *
 * ONE STORE, DELIBERATELY. An earlier version also queried an address-keyed
 * `email_suppressions` table. That table is never created: the migration that
 * would have added it says so at length, because two opt-out systems is worse
 * than either alone, and a reader who unsubscribes from one kind of email and
 * then receives the other has not been given a broken link, they have been
 * given a broken promise. The query was therefore guaranteed to fail with
 * PGRST205 on every single send, which the code then tolerated and ignored: a
 * wasted round trip on the one path that must not be slow, and a live
 * dependency on the exact error code a missing table happens to produce. It is
 * gone. `users.unsubscribed_at` / `unsubscribed_categories` is the opt-out, and
 * /api/email/unsubscribe is what writes it.
 *
 * FAILS CLOSED. If the preference row cannot be read for any reason, this
 * returns true and the send is skipped. Mailing somebody because a query
 * errored is not a mistake that can be taken back.
 */
export async function isSuppressed(
  supabase: SupabaseClient<Database>,
  userId: string,
  category: LifecycleCategory,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .select('unsubscribed_at, unsubscribed_categories')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    console.error(
      `[lifecycle] could not read preferences for ${userId}; treating as opted out`,
    );
    return true;
  }

  if (data.unsubscribed_at) return true;
  return (data.unsubscribed_categories ?? []).includes(category);
}
