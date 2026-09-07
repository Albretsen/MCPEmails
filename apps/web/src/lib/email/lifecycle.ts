/**
 * Shared plumbing for LIFECYCLE email: the non-transactional kind.
 *
 * WHAT COUNTS AS LIFECYCLE. A receipt, an invite, a password reset and a
 * security notice are transactional: the person asked for them by doing
 * something, and they must send whatever anyone's preferences say. Everything
 * else, including a founder writing to ask if you would consider paying, is
 * lifecycle. It is marketing-adjacent, it needs a working one-click opt-out,
 * and it must check that opt-out before every single send.
 *
 * Nothing in this file may be imported by the purchase-confirmation or invite
 * paths. Those two must never learn how to be suppressed.
 *
 * THREE GUARANTEES THIS MODULE PROVIDES
 *
 *   1. NEVER TWICE. `claimSend` inserts into `lifecycle_email_sends` with
 *      ON CONFLICT DO NOTHING, keyed by (user_id, template, trigger_key), and
 *      returns false if the row already existed. The claim happens BEFORE the
 *      send, not after, so a crash between the two loses an email rather than
 *      duplicating one. That trade is deliberate and it is the same one
 *      `stripe_webhook_events` makes: a missed lifecycle email is recoverable
 *      by a human deciding to send it; a duplicate is not recoverable at all.
 *
 *   2. NEVER AFTER THEY SAID STOP. `isSuppressed` reads the preference columns
 *      at send time, even though the recipient query already filtered on them.
 *      The gap between building a list and mailing it is where somebody clicks
 *      unsubscribe.
 *
 *   3. NEVER THROWS. Same posture as purchase-confirmation.ts: every failure is
 *      logged and swallowed, because a batch of 20 must not stop at recipient 4.
 *
 * ENVIRONMENT, all read at call time and never at module load:
 *   RESEND_API_KEY            Resend API key.
 *   LIFECYCLE_EMAIL_FROM      Sender. MUST NOT be the purchase-confirmation
 *                             sender (hello@) or the invite sender (invites@).
 *                             A spam complaint on a founder's ask must not be
 *                             able to take a customer's receipt down with it.
 *                             Default: Asgeir Albretsen <asgeir@mcpemails.com>.
 *   LIFECYCLE_EMAIL_REPLY_TO  Where replies go. Defaults to hello@mcpemails.com,
 *                             which is a mailbox that demonstrably exists and is
 *                             read. Point it at asgeir@ once that alias is live
 *                             in Migadu; an unroutable Reply-To on an email whose
 *                             entire point is "hit reply" is the one bug that
 *                             would waste the whole send.
 *   NEXT_PUBLIC_APP_URL       Base URL for links.
 */

import { Resend } from 'resend';
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
const DEFAULT_REPLY_TO = 'hello@mcpemails.com';

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, '');
}

export function lifecycleFrom(): string {
  return process.env.LIFECYCLE_EMAIL_FROM ?? DEFAULT_FROM;
}

export function lifecycleReplyTo(): string {
  return process.env.LIFECYCLE_EMAIL_REPLY_TO ?? DEFAULT_REPLY_TO;
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
 * PostgREST's way of saying the table is not there. Two codes because the
 * schema-cache miss (PGRST205) and the underlying Postgres error (42P01) surface
 * differently depending on whether the cache has been reloaded yet.
 */
function isMissingRelation(error: { code?: string } | null): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01';
}

/**
 * Has this person asked us not to send this kind of email?
 *
 * TWO STORES ARE CONSULTED, ON PURPOSE.
 *
 *   users.unsubscribed_at / unsubscribed_categories
 *     The per-PERSON preference this module owns. It can express "stop the
 *     founder mail but keep the product notes", which an address-keyed list
 *     cannot.
 *
 *   email_suppressions
 *     An address-keyed opt-out list introduced alongside the billing dunning
 *     sequence. An opt-out is a promise to a MAILBOX, so it must hold even when
 *     the same address later appears under a different user id, and it must hold
 *     across both sequences. Checked here so that somebody who unsubscribed from
 *     a dunning email is not then mailed by this campaign.
 *
 * The `email_suppressions` check TOLERATES the table not existing, and only that
 * one error. The two features are being built at the same time and either may
 * reach production first; a missing table must not stop this campaign, and any
 * other error on that query still fails closed.
 *
 * FAILS CLOSED otherwise. If the preference row cannot be read for any reason,
 * this returns true and the send is skipped. Mailing somebody because a query
 * errored is not a mistake that can be taken back.
 */
export async function isSuppressed(
  supabase: SupabaseClient<Database>,
  userId: string,
  category: LifecycleCategory,
  email?: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .select('email, unsubscribed_at, unsubscribed_categories')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    console.error(
      `[lifecycle] could not read preferences for ${userId}; treating as opted out`,
    );
    return true;
  }

  if (data.unsubscribed_at) return true;
  if ((data.unsubscribed_categories ?? []).includes(category)) return true;

  const address = (email ?? data.email ?? '').trim().toLowerCase();
  if (!address) return true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anySupabase = supabase as unknown as SupabaseClient<any>;
  const { data: suppressed, error: suppressionError } = await anySupabase
    .from('email_suppressions')
    .select('email')
    .eq('email', address)
    .maybeSingle();

  if (suppressionError && !isMissingRelation(suppressionError)) {
    console.error(
      `[lifecycle] could not read email_suppressions for ${userId}; treating as opted out`,
    );
    return true;
  }

  return Boolean(suppressed);
}

// ---------------------------------------------------------------------------
// The send ledger
// ---------------------------------------------------------------------------

export interface SendClaim {
  /** False when this person already has this exact email. Do not send. */
  claimed: boolean;
}

/**
 * Reserve the right to send. Call this BEFORE the send.
 *
 * Returns `{ claimed: false }` when the row already existed, which means the
 * email has already gone out (or has already failed, which is also a decision
 * a human must make again rather than a machine retrying blind).
 */
export async function claimSend(
  supabase: SupabaseClient<Database>,
  args: { userId: string; template: string; triggerKey: string; email: string },
): Promise<SendClaim> {
  const { data, error } = await supabase
    .from('lifecycle_email_sends')
    .upsert(
      {
        user_id: args.userId,
        template: args.template,
        trigger_key: args.triggerKey,
        email: args.email,
        status: 'sent',
      },
      { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
    )
    .select('user_id');

  if (error) {
    // A ledger we cannot write to is a ledger that cannot prevent a duplicate,
    // so the only safe answer is to not send.
    console.error(`[lifecycle] ledger claim failed for ${args.userId}: ${error.message}`);
    return { claimed: false };
  }

  // `ignoreDuplicates` turns a conflict into zero returned rows.
  return { claimed: (data?.length ?? 0) > 0 };
}

/**
 * Record what actually happened, on the row already claimed above.
 *
 * A failure is written as `status = 'failed'` and the row is KEPT. That is not
 * an oversight: leaving the row behind means the next run skips this person
 * instead of trying again, and a human looks at the ledger and decides. Clearing
 * failures automatically is how a flaky afternoon turns into three copies of a
 * personal email.
 */
export async function finaliseSend(
  supabase: SupabaseClient<Database>,
  args: {
    userId: string;
    template: string;
    triggerKey: string;
    status: 'sent' | 'failed';
    providerMessageId?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from('lifecycle_email_sends')
    .update({
      status: args.status,
      provider_message_id: args.providerMessageId ?? null,
      detail: args.detail ?? null,
    })
    .eq('user_id', args.userId)
    .eq('template', args.template)
    .eq('trigger_key', args.triggerKey);

  if (error) {
    console.error(`[lifecycle] ledger finalise failed for ${args.userId}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  return key ? new Resend(key) : null;
}

/** Keep anything unexpected out of the logs verbatim; short safe strings only. */
export function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_.:\- ]{1,120}$/i.test(value)
    ? value
    : 'unexpected_response';
}

export interface LifecycleSendResult {
  ok: boolean;
  messageId: string | null;
  detail: string | null;
}

/**
 * One attempt. No retry, for the same reason purchase-confirmation.ts does not
 * retry: a blind retry after a lost response is how somebody gets two copies of
 * an email that reads as if it were typed by hand.
 *
 * The List-Unsubscribe pair is what makes this legitimate bulk mail rather than
 * something a mailbox provider is entitled to treat as spam. `List-Unsubscribe-Post`
 * with `One-Click` (RFC 8058) tells Gmail and friends that the URL may be POSTed
 * to directly, with no confirmation page and no login, which is exactly what the
 * route on the other end implements.
 */
export async function sendLifecycleEmail(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  unsubscribeUrl: string;
  idempotencyKey: string;
}): Promise<LifecycleSendResult> {
  try {
    const resend = getResend();
    if (!resend) {
      return { ok: false, messageId: null, detail: 'no_resend_api_key' };
    }

    const to = args.to?.trim() ?? '';
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return { ok: false, messageId: null, detail: 'unusable_recipient' };
    }

    const payload: Parameters<typeof resend.emails.send>[0] = {
      from: lifecycleFrom(),
      to,
      replyTo: lifecycleReplyTo(),
      subject: args.subject,
      text: args.text,
      headers: {
        'List-Unsubscribe': `<${args.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    if (args.html) payload.html = args.html;

    const { data, error } = await resend.emails.send(payload, {
      idempotencyKey: args.idempotencyKey.slice(0, 256),
    });

    if (error) {
      return { ok: false, messageId: null, detail: safeCode(error.message) };
    }

    return { ok: true, messageId: data?.id ?? null, detail: null };
  } catch (err) {
    return {
      ok: false,
      messageId: null,
      detail: safeCode(err instanceof Error ? err.message : String(err)),
    };
  }
}
