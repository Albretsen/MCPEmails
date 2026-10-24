/**
 * Claim due `billing_email_sends` rows and send them.
 *
 * Shared by the cron route (app/api/internal/billing-lifecycle/dispatch, a full
 * sweep every five minutes) and the immediate kick (dispatch-kick.ts, which
 * runs after the response of the request that queued a row due now, and
 * dispatches only those row ids). Every safety lives here, so both paths get
 * all of them:
 *
 *   - THE CLAIM IS EXCLUSIVE. A full sweep claims through
 *     `claim_billing_emails()` (one UPDATE over a FOR UPDATE SKIP LOCKED
 *     subquery). A narrow dispatch claims each id with one conditional UPDATE
 *     whose WHERE repeats the claimable predicate and the attempts count it
 *     read (compare-and-set). Postgres re-checks that WHERE against the row's
 *     latest version after waiting on its lock, so whichever claim commits
 *     first wins and the other matches zero rows. A row can therefore never be
 *     claimed, and so never sent, by a cron run and a kick at the same time.
 *   - Deleted accounts get nothing; marketing mail honours opt-outs at send
 *     time.
 *   - FRESHNESS. Every claimed row is re-checked immediately before its send
 *     (Stripe, the Free allowance, or user_passes) and cancelled if the world
 *     has moved on. A read failure leaves the row claimed; the 15-minute lease
 *     expires and the cron retries it.
 *   - BILLING_LIFECYCLE_EMAILS: `off` sends nothing and claims nothing;
 *     `queue_only` composes and reports, then releases the claim.
 *   - One attempt per claim, under the Resend Idempotency-Key, so a crash
 *     between the send and the `sent_at` write is collapsed by Resend.
 *
 * Never throws: a failure is logged and the row is left for the cron.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  composeBillingEmail,
  isPassTemplate,
  isUsageTemplate,
  payloadForQueueRow,
  sendBillingLifecycleEmail,
  sendInputForQueueRow,
  type BillingTemplate,
  type LifecyclePayload,
  type LifecycleQueueRowInput,
} from '@/lib/email/billing-lifecycle';
import { resolveUserId } from '@/lib/billing/lifecycle-queue';
import { ACCOUNT_DELETED_REASON, accountState } from '@/lib/billing/deleted-account';
import { checkPassNoticeFreshness } from '@/lib/billing/pass-notice-freshness';
import { primaryWorkspaceId, recordPassEvent } from '@/lib/analytics/billing-funnel';
import { isSuppressed } from '@/lib/email/lifecycle';
import { lifecycleMode, type LifecycleMode } from '@/lib/billing/lifecycle-mode';
import {
  BATCH_SIZE,
  RETRY_REASON,
  budgetExhausted,
  checkFreshness,
  type FreshnessStripe,
} from '@/lib/billing/dispatch-freshness';
import type { Database } from '@/types/database.types';

type Db = SupabaseClient<Database>;

/** Mirrors claim_billing_emails(): attempts < 5 and a 15-minute lease. */
export const MAX_ATTEMPTS = 5;

/**
 * A claimed `billing_email_sends` row. `stripe_customer_id` OR `workspace_id`
 * is set (CHECK billing_email_sends_keyed); never neither.
 */
export interface QueueRow extends LifecycleQueueRowInput {
  id: number;
  stripe_customer_id: string | null;
  workspace_id: string | null;
  period_start: string | null;
  user_id: string | null;
  recipient: string;
  template: BillingTemplate;
  category: 'transactional' | 'marketing';
  scope_key: string;
  payload: LifecyclePayload;
  attempts: number;
}

export interface DispatchResult {
  claimed: number;
  sent: number;
  cancelled: number;
  failed: number;
  dryRun: number;
  /** queue_only: what would have gone out, recipients masked. */
  wouldSend: Array<{
    id: number;
    template: BillingTemplate;
    scope: string;
    to: string;
    subject: string | null;
  }>;
}

export type DispatchOutcome =
  | ({ ok: true; mode: Exclude<LifecycleMode, 'off'> } & DispatchResult)
  | { ok: true; skipped: 'BILLING_LIFECYCLE_EMAILS=off' }
  | { ok: false; error: 'claim_failed' };

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * Claim specific rows, compare-and-set, one UPDATE per id. Only rows that are
 * due, unsent, uncancelled, under the attempt cap and UNCLAIMED are taken: a
 * kick is for rows queued a moment ago, and a row whose lease is merely stale
 * is the cron's to retry. Returns the rows this call claimed; a row another
 * dispatcher claimed first is simply absent.
 */
export async function claimRowsById(db: Db, ids: number[], now: Date = new Date()): Promise<QueueRow[]> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
  if (unique.length === 0) return [];
  const nowIso = now.toISOString();

  const { data: candidates, error } = await db
    .from('billing_email_sends')
    .select('id, attempts')
    .in('id', unique)
    .is('sent_at', null)
    .is('cancelled_at', null)
    .is('claimed_at', null)
    .lte('send_after', nowIso);
  if (error) throw new Error(error.message);

  const claimed: QueueRow[] = [];
  for (const candidate of candidates ?? []) {
    if (candidate.attempts >= MAX_ATTEMPTS) continue;
    const { data, error: claimError } = await db
      .from('billing_email_sends')
      .update({ claimed_at: nowIso, attempts: candidate.attempts + 1 })
      .eq('id', candidate.id)
      .eq('attempts', candidate.attempts)
      .is('claimed_at', null)
      .is('sent_at', null)
      .is('cancelled_at', null)
      .select('*');
    if (claimError) {
      console.error(`[lifecycle-dispatch] claim of row ${candidate.id} failed: ${claimError.message}`);
      continue;
    }
    // Through `unknown`: the generated row type and QueueRow differ in the
    // narrowed template/category/payload types only.
    const row = (data ?? [])[0] as unknown as QueueRow | undefined;
    if (row) claimed.push(row);
  }
  return claimed;
}

async function claimDue(db: Db): Promise<QueueRow[]> {
  const { data, error } = await db.rpc('claim_billing_emails', { p_limit: BATCH_SIZE });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as QueueRow[];
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Claim and send. With `ids`, only those rows (the immediate kick); without,
 * up to BATCH_SIZE of whatever is due (the cron). Never throws.
 */
export async function dispatchBillingEmails(options: {
  db: Db;
  stripe: FreshnessStripe;
  ids?: number[];
}): Promise<DispatchOutcome> {
  const { db, stripe, ids } = options;

  // Read at call time, never captured at module load: a warm lambda would
  // otherwise keep the value it booted with and the kill switch would need a
  // redeploy to take effect. See src/lib/billing/lifecycle-mode.ts.
  const lifecycle = lifecycleMode();
  if (lifecycle === 'off') return { ok: true, skipped: 'BILLING_LIFECYCLE_EMAILS=off' };

  const started = Date.now();
  let rows: QueueRow[];
  try {
    rows = ids ? await claimRowsById(db, ids) : await claimDue(db);
  } catch (err) {
    console.error('[lifecycle-dispatch] claim failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, error: 'claim_failed' };
  }

  const result: DispatchResult = { claimed: rows.length, sent: 0, cancelled: 0, failed: 0, dryRun: 0, wouldSend: [] };

  for (const row of rows) {
    if (budgetExhausted(started, Date.now())) {
      // Leave the rest claimed; the lease expires and the next tick takes them.
      console.log('[lifecycle-dispatch] wall-clock budget reached; yielding.');
      break;
    }
    try {
      await dispatchOne(db, stripe, row, lifecycle, result);
    } catch (err) {
      // Leave it claimed; the lease expires and the cron retries it.
      console.error(`[lifecycle-dispatch] row ${row.id} failed unexpectedly:`, {
        error: err instanceof Error ? err.message : String(err),
      });
      result.failed += 1;
    }
  }

  return { ok: true, mode: lifecycle, ...result };
}

async function dispatchOne(
  db: Db,
  stripe: FreshnessStripe,
  row: QueueRow,
  lifecycle: Exclude<LifecycleMode, 'off'>,
  result: DispatchResult,
): Promise<void> {
  // ── Deleted account, EVERY template ──────────────────────────────────
  //
  // Someone who deleted their account gets nothing from this queue, not
  // even transactional mail. The webhook skips queueing for a subscription
  // that delete-account cancelled, but a subscription cancelled another way
  // on an already-deleted account (the Stripe dashboard, or Stripe at the
  // end of its retries) still queued cancel_ask and both win-backs. Asked
  // here, at send time, because the account can also be deleted in the two
  // weeks between queueing a win-back and sending it. A row queued without
  // a user id is looked up through the Stripe customer it is keyed on.
  const ownerId =
    row.user_id ??
    (row.stripe_customer_id ? await resolveUserId(db, row.stripe_customer_id, null) : null);
  const account = await accountState(db, ownerId);
  if (account === 'unknown') return; // auth read failed; lease expires, next tick asks again
  if (account === 'deleted') {
    await finish(db, row.id, { cancelled: ACCOUNT_DELETED_REASON });
    result.cancelled += 1;
    return;
  }

  // ── Suppression + opt-out link, MARKETING ONLY ────────────────────────
  //
  // The `category` column is GENERATED from the template name in the
  // database, so a transactional row cannot reach this branch at all, no
  // matter what preferences the recipient has set. That is the whole point: a
  // customer who opted out of win-backs must still be told their card failed.
  //
  // The check reuses src/lib/email/lifecycle.ts rather than owning a second
  // opt-out mechanism, and it reads the preference HERE rather than trusting
  // the one that held when the row was queued, because the gap between
  // queueing a win-back and sending it is two weeks and that is exactly where
  // somebody clicks unsubscribe.
  if (row.category === 'marketing') {
    if (!row.user_id) {
      // No user row means no preferences to honour and no token to sign a
      // link with. Fail closed: marketing mail we cannot let them stop is
      // marketing mail we do not send.
      await finish(db, row.id, { cancelled: 'suppressed', error: 'no_user_row' });
      result.cancelled += 1;
      return;
    }
    if (await isSuppressed(db, row.user_id, 'lifecycle')) {
      await finish(db, row.id, { cancelled: 'suppressed' });
      result.cancelled += 1;
      return;
    }
    const { data: profile } = await db
      .from('users')
      .select('unsubscribe_token')
      .eq('id', row.user_id)
      .maybeSingle();
    if (!profile?.unsubscribe_token) {
      await finish(db, row.id, { cancelled: 'suppressed', error: 'no_unsubscribe_token' });
      result.cancelled += 1;
      return;
    }
    // Injected fresh, never frozen into the queued payload, so a rotated
    // token cannot leave a dead opt-out link in an email sent a month later.
    row.payload = { ...(row.payload ?? {}), unsubscribeToken: profile.unsubscribe_token };
  }

  // The usage notices have nothing in Stripe to check against; their
  // freshness question is whether the Free allowance still applies. The
  // suppression branch above is never entered for them either: their
  // GENERATED category is transactional, so an owner cannot opt out of being
  // told their own service is about to stop.
  //
  // The pass notices have nothing in Stripe to check either: their question
  // is whether the pass still ends as the row says (not refunded, no
  // subscription since, no second pass after it), asked of user_passes.
  const fresh = isUsageTemplate(row.template)
    ? await checkAllowanceFreshness(db, row)
    : isPassTemplate(row.template)
      ? await checkPassNoticeFreshness(db, row)
      : await checkFreshness(stripe, row);
  if (!fresh.send) {
    if (fresh.reason === RETRY_REASON) return; // leave it; lease expires
    await finish(db, row.id, { cancelled: fresh.reason });
    result.cancelled += 1;
    return;
  }

  if (lifecycle !== 'on') {
    // queue_only: everything above ran for real against real Stripe data, and
    // this is where a customer would have received something. Compose it
    // anyway, so the subject line in the report is the one that would have
    // been used and a template that cannot compose shows up here rather than
    // on the day the switch is flipped. Recipients are masked because this
    // lands in a Vercel log line and a cron response body.
    const composed = composeBillingEmail(row.template, payloadForQueueRow(row));
    result.wouldSend.push({
      id: row.id,
      template: row.template,
      scope: row.scope_key,
      to: maskAddress(row.recipient),
      subject: composed?.subject ?? null,
    });
    // Release the claim so the row stays visible and due for inspection.
    await db
      .from('billing_email_sends')
      .update({ claimed_at: null, attempts: Math.max(0, row.attempts - 1) })
      .eq('id', row.id);
    result.dryRun += 1;
    return;
  }

  // One attempt, never a retry inside the send; the queue retries on the
  // next tick under the same Idempotency-Key, which for a workspace-keyed
  // row is (workspace_id, template, period_start). See lifecycleIdempotencyKey.
  const send = await sendBillingLifecycleEmail(sendInputForQueueRow(row));

  if (send.ok) {
    await finish(db, row.id, { sent: send.resendId });
    result.sent += 1;
    if (isPassTemplate(row.template) && row.user_id) {
      // Best-effort and never throws: the email is already gone.
      await recordPassEvent({
        workspaceId: await primaryWorkspaceId(db, row.user_id),
        stage: 'pass_reminder_sent',
        category: 'pass_reminder',
      });
    }
  } else if (send.reason === 'unusable_recipient' || send.reason === 'not_composable') {
    // Permanent. Retrying cannot help, so stop rather than burn five attempts.
    await finish(db, row.id, { cancelled: 'undeliverable', error: send.reason });
    result.cancelled += 1;
  } else {
    await db
      .from('billing_email_sends')
      .update({ last_error: send.reason, claimed_at: null })
      .eq('id', row.id);
    result.failed += 1;
  }
}

/**
 * `asgeir@mcpemails.com` to `a****r@mcpemails.com`. Enough to recognise an
 * address you already know, not enough to be a customer list in a log file.
 */
export function maskAddress(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '****';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0] ?? '*'}****${domain}`;
  return `${local[0]}****${local[local.length - 1]}${domain}`;
}

/**
 * The one row of `workspace_action_allowance()` this decision reads. The
 * function is declared in 20260912200000_free_action_cap_150.sql; the local
 * shape and the cast below keep this independent of the generated types.
 */
interface AllowanceRow {
  exempt: boolean | null;
  cap: number | null;
  period_start: string | null;
}

/**
 * "Is this usage notice still true?", asked of the allowance function
 * immediately before the send.
 *
 * Cancels when the cap no longer applies (the workspace was exempted, comped
 * or upgraded since the row was queued: `exempt` or a NULL `cap`) or when the
 * period it describes is over (the allowance now reports a later
 * `period_start`, so the count it quotes has reset). A workspace that no
 * longer exists cancels too. A read failure returns RETRY_REASON, exactly as
 * the Stripe check does: the row stays claimed, the lease expires, and the
 * next run asks again. A notice delayed by fifteen minutes costs nothing; one
 * that tells a brand-new Personal customer their actions are refused costs
 * the sale it just made.
 */
async function checkAllowanceFreshness(
  db: Db,
  row: QueueRow,
): Promise<{ send: true } | { send: false; reason: string }> {
  if (!row.workspace_id) {
    // Unreachable under the keyed CHECK plus the template CHECK, but a usage
    // row with no workspace has no allowance to describe.
    return { send: false, reason: 'no_workspace' };
  }
  try {
    const rpc = (db as unknown as {
      rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message: string } | null;
      }>;
    }).rpc.bind(db);
    const { data, error } = await rpc('workspace_action_allowance', {
      p_workspace_id: row.workspace_id,
    });
    if (error) throw new Error(error.message);

    const allowance = (Array.isArray(data) ? data[0] : data) as AllowanceRow | null | undefined;
    if (!allowance) return { send: false, reason: 'workspace_gone' };
    if (allowance.exempt || allowance.cap == null) {
      return { send: false, reason: 'allowance_lifted' };
    }
    if (
      row.period_start &&
      allowance.period_start &&
      new Date(allowance.period_start).getTime() > new Date(row.period_start).getTime()
    ) {
      return { send: false, reason: 'period_ended' };
    }
    return { send: true };
  } catch (err) {
    console.error(`[lifecycle-dispatch] allowance check failed for row ${row.id}:`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { send: false, reason: RETRY_REASON };
  }
}

async function finish(
  db: Db,
  id: number,
  outcome: { sent?: string | null } | { cancelled: string; error?: string },
): Promise<void> {
  const patch =
    'cancelled' in outcome
      ? {
          cancelled_at: new Date().toISOString(),
          cancel_reason: outcome.cancelled,
          ...(outcome.error ? { last_error: outcome.error } : {}),
        }
      : { sent_at: new Date().toISOString(), resend_id: outcome.sent ?? null };

  const { error } = await db.from('billing_email_sends').update(patch).eq('id', id);
  if (error) {
    // The email is already gone. Loud, because a row stuck unsent-but-delivered
    // is the one state that could produce a duplicate on a later lease expiry.
    // The Resend Idempotency-Key is what stops that becoming a second email.
    console.error(`[lifecycle-dispatch] could not finish row ${id}: ${error.message}`);
  }
}
