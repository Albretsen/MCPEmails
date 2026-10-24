// ---------------------------------------------------------------------------
// payment-notice.ts - the once-a-day billing notice on a tool result.
//
// While the workspace owner's renewal payment is failing, the Stripe webhook
// marks every workspace they own (workspaces.payment_issue_since and
// payment_issue_kind; apps/web/src/lib/billing/payment-issue.ts). The first
// SUCCESSFUL tool call of each UTC day then carries one fixed, server-authored
// line saying so, so the person in the chat learns about it without opening
// the dashboard.
//
// Rules, all deliberate:
//   - Service is never limited. The note says so, and nothing reads these
//     columns to decide what a call may do.
//   - Successful results only. Never on an error or a paywall refusal (both
//     are isError results, and attachResultNote skips those anyway).
//   - At most once per workspace per UTC day, across every key and isolate:
//     the day is CLAIMED with a conditional update before the note is attached,
//     so of two concurrent calls only the one whose update returned a row says
//     it.
//   - It is account status, not promotion: no purchase link, no upsell, and
//     only while a real payment is failing.
//   - It can never fail the call. Any error is logged and the result goes out
//     as it would have without the note.
// ---------------------------------------------------------------------------

export type PaymentIssueKind = "declined" | "confirm";

/** The three workspace columns this reads, as PostgREST returns them. */
export interface PaymentIssueMarkers {
  payment_issue_since?: string | null;
  payment_issue_kind?: string | null;
  payment_notice_shown_on?: string | null;
}

const DECLINED_TEXT =
  "MCPEmails billing notice: the last subscription payment for this account did not go through. " +
  "Nothing is limited. The account owner can fix it at https://mcpemails.com/dashboard/settings " +
  "(shown at most once a day).";

const CONFIRM_TEXT =
  "MCPEmails billing notice: the account owner's bank is asking them to confirm the last " +
  "subscription payment. Nothing is limited. They can do it at " +
  "https://mcpemails.com/dashboard/settings (shown at most once a day).";

/** The fixed line for a kind. Anything but 'confirm' reads as a decline. */
export function paymentNoticeText(kind: string | null | undefined): string {
  return kind === "confirm" ? CONFIRM_TEXT : DECLINED_TEXT;
}

/** Today's UTC calendar day, `YYYY-MM-DD`, the format a Postgres `date` returns. */
export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Should this call try to claim today's notice?
 *
 * Only when a payment issue is recorded and the notice has not been shown on
 * `todayUtc`. A `shownOn` from another day (or a malformed one) does not
 * count as today.
 */
export function shouldShowPaymentNotice(input: {
  paymentIssueSince: string | null | undefined;
  shownOn: string | null | undefined;
  todayUtc: string;
}): boolean {
  if (!input.paymentIssueSince) return false;
  const shown = typeof input.shownOn === "string" ? input.shownOn.slice(0, 10) : null;
  return shown !== input.todayUtc;
}

/** The slice of the Supabase client the claim uses. */
export interface PaymentNoticeDb {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

/**
 * Claim `todayUtc` for this workspace. True only when THIS call's update
 * changed the row: the update is conditional on the day not being claimed
 * yet, and on an issue still being recorded (it may have cleared since the
 * row was read).
 */
export async function claimPaymentNoticeDay(
  db: PaymentNoticeDb,
  workspaceId: string,
  todayUtc: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("workspaces")
    .update({ payment_notice_shown_on: todayUtc })
    .eq("id", workspaceId)
    .not("payment_issue_since", "is", null)
    .or(`payment_notice_shown_on.is.null,payment_notice_shown_on.neq.${todayUtc}`)
    .select("id");
  if (error) throw new Error(error.message ?? String(error));
  return Array.isArray(data) && data.length > 0;
}

/**
 * The whole step, for handleToolsCall: decide, claim, attach. Never throws.
 * Returns true when the note was attached.
 */
export async function maybeAttachPaymentNotice(options: {
  db: PaymentNoticeDb;
  workspaceId: string;
  markers: PaymentIssueMarkers | undefined;
  /** True only for a successful tool result. */
  succeeded: boolean;
  attach: (note: string) => void;
  nowMs?: number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<boolean> {
  const log = options.log ?? ((event, fields) => console.log(`[mcp-server] ${event}`, fields));
  try {
    if (!options.succeeded || !options.markers) return false;
    const todayUtc = utcDay(options.nowMs);
    if (
      !shouldShowPaymentNotice({
        paymentIssueSince: options.markers.payment_issue_since,
        shownOn: options.markers.payment_notice_shown_on,
        todayUtc,
      })
    ) {
      return false;
    }
    if (!(await claimPaymentNoticeDay(options.db, options.workspaceId, todayUtc))) return false;
    const kind = options.markers.payment_issue_kind === "confirm" ? "confirm" : "declined";
    options.attach(paymentNoticeText(kind));
    log("payment_notice_shown", { workspace_id: options.workspaceId, kind });
    return true;
  } catch (err) {
    log("payment_notice_failed", {
      workspace_id: options.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
