/**
 * /admin/growth/dunning: the billing lifecycle email queue, made visible.
 *
 * WHY THIS PAGE EXISTS. Everything else in this feature runs unattended: a cron
 * job pokes a route, the route claims rows and hands them to Resend, and until
 * this page there was no surface anywhere that said whether any of it had
 * happened. A revenue-recovery mechanism nobody can see is one nobody can tell
 * is broken, and the way this one breaks is silently: a missing Stripe event
 * subscription, a 403 on the cron POST, or a kill switch left at `off` all look
 * identical from outside, and all of them look exactly like "nobody's card
 * failed this week".
 *
 * So the first thing on the page is not a number. It is the switch position and
 * the last time anything was sent, because those two answer "is this thing
 * running" and every figure below them is meaningless if the answer is no.
 *
 * THE SAME HONESTY RULES AS THE REST OF THE BOARD. Counts, not rates, until a
 * denominator can carry one. No p-values. Recovery is labelled as the
 * correlation it is, with Stripe's unaided retries printed next to it so the
 * two are never confused. See src/lib/billing/dunning-stats.ts.
 *
 * PRIVACY. Recipients are masked. This page sits behind the ADMIN_EMAILS
 * session like the rest of /admin/growth, and unlike the kiosk board it is
 * never shown on a wall, but a customer's full address has no reason to be on
 * a screen to answer any question this page asks.
 *
 * NO CLIENT JAVASCRIPT. Server-rendered, same as the experiments panel.
 */

import { requireAdmin } from '@/lib/admin/require-admin';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { lifecycleMode } from '@/lib/billing/lifecycle-mode';
import {
  MIN_SEQUENCES_FOR_RATE,
  fetchDunningRows,
  fetchFixClicks,
  fetchSubscriptionDeletions,
  maskAddress,
  summariseChurn,
  summariseDunning,
  summariseFixClicks,
  summariseOutcomes,
  type ChurnMonth,
  type DeletionRow,
  type DunningRow,
  type DunningSummary,
  type FixClickSummary,
  type OutcomeSummary,
} from '@/lib/billing/dunning-stats';
import { ChartFrame, NO_DATA, formatCount, formatMoney, formatPercent } from '../../../../components/admin/charts';
import '../../../../styles/admin-board.css';
import '../../../../styles/admin-experiments.css';

export const metadata = {
  title: 'Dunning',
  robots: { index: false, follow: false },
};

/** The queue changes on every cron tick, so nothing here is cached. */
export const dynamic = 'force-dynamic';

const MODE_WORDS: Record<string, string> = {
  off: 'Nothing is queued and nothing is sent. The webhook behaves as it did before this feature existed.',
  queue_only:
    'Sequences are materialised from real Stripe events and the dispatcher reports what it would send, without sending it. No customer receives anything.',
  on: 'Live. Customers receive these emails.',
};

const TEMPLATE_WORDS: Record<string, string> = {
  dunning_1: 'Day 0, within an hour of the decline',
  dunning_3: 'Day 3',
  dunning_7: 'Day 7',
  dunning_14: 'Day 14, the last note',
  card_expiry_30: 'Card expires next month',
  card_expiry_7: 'Card expires next week',
  cancel_ask: 'What stopped working for you?',
  winback_14: 'Win-back, 14 days after the period ended',
  winback_30: 'Win-back, the last email',
};

function when(iso: string | null): string {
  if (!iso) return NO_DATA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NO_DATA;
  return d.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';
}

export default async function DunningPage() {
  await requireAdmin();

  const db = createServiceRoleClient();
  let rows: DunningRow[] = [];
  let loadError: string | null = null;
  let truncated = false;
  try {
    const loaded = await fetchDunningRows(db);
    rows = loaded.rows;
    truncated = loaded.truncated;
  } catch (err) {
    // The overwhelmingly likely cause is that the migrations have not been
    // applied yet. Say that, rather than rendering an empty board that reads as
    // "nothing has happened".
    loadError = err instanceof Error ? err.message : String(err);
  }

  // The two side reads fail on their own panels, never the whole board.
  let deletions: DeletionRow[] = [];
  let reasonColumn = false;
  let churnError: string | null = null;
  try {
    const loaded = await fetchSubscriptionDeletions(db);
    deletions = loaded.rows;
    reasonColumn = loaded.reasonColumn;
  } catch (err) {
    churnError = err instanceof Error ? err.message : String(err);
  }

  let clicks: FixClickSummary | null = null;
  let clicksError: string | null = null;
  try {
    clicks = summariseFixClicks(await fetchFixClicks(db));
  } catch (err) {
    clicksError = err instanceof Error ? err.message : String(err);
  }

  const summary = summariseDunning(rows);
  const outcomes = summariseOutcomes(rows, deletions);
  const churn = summariseChurn(deletions);
  const mode = lifecycleMode();

  return (
    <main className="board">
      <header className="bd-head">
        <h1>Dunning and lifecycle email</h1>
        <p className="bd-head-sub">
          A declined renewal used to produce one visible effect: a status flip nobody saw. This is
          the queue that writes to the customer instead, and whether it is working.
        </p>
      </header>

      <RunningState mode={mode} summary={summary} loadError={loadError} truncated={truncated} />

      {loadError ? null : (
        <div className="bd-grid" style={{ marginTop: 14 }}>
          <div style={{ gridColumn: 'span 12' }}>
            <Recovery summary={summary} />
          </div>
          <div style={{ gridColumn: 'span 7' }}>
            <ByDeclineCode outcomes={outcomes} />
          </div>
          <div style={{ gridColumn: 'span 5' }}>
            <RecoveryRate outcomes={outcomes} />
          </div>
          <div style={{ gridColumn: 'span 7' }}>
            <InvoluntaryChurn months={churn} reasonColumn={reasonColumn} error={churnError} />
          </div>
          <div style={{ gridColumn: 'span 5' }}>
            <BannerReach clicks={clicks} error={clicksError} outcomes={outcomes} />
          </div>
          <div style={{ gridColumn: 'span 7' }}>
            <ByTemplate summary={summary} />
          </div>
          <div style={{ gridColumn: 'span 5' }}>
            <WhyCancelled summary={summary} />
          </div>
          <div style={{ gridColumn: 'span 12' }}>
            <NeedsAPerson summary={summary} rows={rows} />
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * The switch, and the last send. Deliberately first and deliberately not a
 * chart: every number below it is meaningless if the answer here is "off".
 */
function RunningState({
  mode,
  summary,
  loadError,
  truncated,
}: {
  mode: string;
  summary: DunningSummary;
  loadError: string | null;
  truncated: boolean;
}) {
  return (
    <article className="ac-card xp-card">
      <div className="xp-head">
        <h2>State</h2>
        <span className={`xp-pill ${mode === 'on' ? 'xp-pill-running' : mode === 'queue_only' ? 'xp-pill-concluded' : 'xp-pill-draft'}`}>
          {`BILLING_LIFECYCLE_EMAILS = ${mode}`}
        </span>
      </div>
      <p className="xp-desc">{MODE_WORDS[mode] ?? MODE_WORDS.off}</p>

      {loadError ? (
        <p className="xp-note xp-sum-bad">
          {`The queue could not be read: ${loadError}. If this says the table is missing, the three billing lifecycle migrations have not been applied yet, and nothing below this line has ever run.`}
        </p>
      ) : (
        <>
          <p className="xp-sum">
            <span>Queued and waiting <b>{formatCount(summary.states.pending)}</b></span>
            <span>Due now <b>{formatCount(summary.states.due)}</b></span>
            <span>Sent <b>{formatCount(summary.states.sent)}</b></span>
            <span>Cancelled <b>{formatCount(summary.states.cancelled)}</b></span>
            <span className={summary.states.failing > 0 ? 'xp-sum-bad' : undefined}>
              Failed at least once <b>{formatCount(summary.states.failing)}</b>
            </span>
          </p>
          <p className="xp-dates">
            <span><b>Last send:</b> {when(summary.lastSentAt)}</span>
            <span><b>Rows in the queue:</b> {formatCount(summary.total)}</span>
          </p>
          {summary.states.due > 0 && mode === 'off' ? (
            <p className="xp-note xp-sum-bad">
              {`${summary.states.due} row(s) are past their send_after and the switch is off, so nothing will pick them up. They are not lost; they become due the moment it is turned on.`}
            </p>
          ) : null}
          {truncated ? (
            <p className="xp-note xp-sum-bad">
              The queue is larger than this page reads. Every figure below is a floor, not a total.
            </p>
          ) : null}
          <p className="xp-hint">
            Cron runs the dispatcher every five minutes and the card sweep daily at 09:00 UTC. A last
            send far in the past with rows due now means the cron POST is not arriving: check
            DISPATCH_SECRET against the Vault secret, because a mismatch is answered 403 and is
            silent from both ends.
          </p>
        </>
      )}
    </article>
  );
}

/** Did writing to them get the money back? Stated as the correlation it is. */
function Recovery({ summary }: { summary: DunningSummary }) {
  const { recovery } = summary;
  const enough = recovery.emailed >= MIN_SEQUENCES_FOR_RATE;
  const rate = recovery.emailed > 0 ? recovery.recoveredAfterEmail / recovery.emailed : 0;

  return (
    <ChartFrame
      title="Recovered revenue"
      subtitle="Dunning sequences where at least one email went out, and the invoice was paid afterwards."
      footnote={
        'This is a correlation, not an attribution. Stripe retries a declined card on its own schedule whether or not we write, so some of these would have recovered in silence. The unaided column is the honest comparison, and at this volume both are counts, not rates.'
      }
    >
      <div className="xp-sum" style={{ margin: 0, fontSize: 13 }}>
        <span>
          Recovered after an email <b>{formatCount(recovery.recoveredAfterEmail)}</b>
          {enough ? <span style={{ marginLeft: 6 }}>{`(${formatPercent(rate)} of ${formatCount(recovery.emailed)} emailed)`}</span> : null}
        </span>
        <span>
          Cash on those invoices <b>{recovery.recoveredCents > 0 ? formatMoney(recovery.recoveredCents, recovery.currency) : NO_DATA}</b>
        </span>
        <span>
          Recovered before any email <b>{formatCount(recovery.recoveredBeforeEmail)}</b>
          <span style={{ marginLeft: 6 }}>(Stripe&apos;s retry, unaided)</span>
        </span>
      </div>
      {!enough ? (
        <p className="xp-note">
          {`Fewer than ${MIN_SEQUENCES_FOR_RATE} sequences have reached a send, so no rate is shown. Read the counts.`}
        </p>
      ) : null}
    </ChartFrame>
  );
}

const DECLINE_WORDS: Record<string, string> = {
  insufficient_funds: 'Not enough funds',
  expired_card: 'Card expired',
  card_declined: 'Declined, no reason given',
  generic_decline: 'Declined, no reason given',
  do_not_honor: 'Bank refused',
  lost_card: 'Card reported lost',
  stolen_card: 'Card reported stolen',
  incorrect_cvc: 'Wrong CVC',
  processing_error: 'Processing error',
};

/**
 * Sequences by the decline code on the failed attempt. Counts only: a code
 * holds a handful of sequences at most, and the point is to see which reasons
 * get fixed at all. SCA (authentication_required) is its own labelled row
 * because no retry can approve it; only the customer can.
 */
function ByDeclineCode({ outcomes }: { outcomes: OutcomeSummary }) {
  const rows = outcomes.byDeclineCode;
  return (
    <ChartFrame
      title="By decline code"
      subtitle="One row per reason the bank gave: recovered, lost (subscription deleted) or still open."
      footnote="Lost means the subscription was deleted after the sequence started: a row cancelled as subscription_deleted, or a deletion event for the same customer. Open sequences are still inside the retry window."
    >
      {rows.length === 0 ? (
        <p className="xp-note">No dunning sequence has been queued yet.</p>
      ) : (
        <table className="ac-table xp-table">
          <thead>
            <tr>
              <th scope="col">Decline code</th>
              <th scope="col">Sequences</th>
              <th scope="col">Recovered</th>
              <th scope="col">Lost</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.code ?? 'none'}>
                <th scope="row">
                  {row.sca ? 'Bank confirmation (SCA)' : row.code ?? 'no code'}
                  <span className="xp-control-tag">
                    {row.sca
                      ? 'authentication_required: only the customer can approve it'
                      : row.code
                        ? DECLINE_WORDS[row.code] ?? ''
                        : 'Stripe gave none'}
                  </span>
                </th>
                <td>{formatCount(row.sequences)}</td>
                <td>{formatCount(row.recovered)}</td>
                <td>{formatCount(row.lost)}</td>
                <td>{formatCount(row.open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ChartFrame>
  );
}

function days(value: number | null): string {
  if (value == null) return NO_DATA;
  return value < 1 ? `${Math.round(value * 24)} h` : `${value.toFixed(1)} days`;
}

/**
 * Recovered over closed (recovered + lost), the time it took, and who did it.
 * The rate is withheld below MIN_SEQUENCES_FOR_RATE closed sequences.
 */
function RecoveryRate({ outcomes }: { outcomes: OutcomeSummary }) {
  const by = outcomes.recoveredBy;
  return (
    <ChartFrame
      title="Recovery rate"
      subtitle="Of the sequences that have finished, how many got paid."
      footnote="Time to recover runs from the queued sequence to the payment_recovered cancel. Customer = paid with a different payment method than the one that failed, or the paying charge ran 3-D Secure. Retry = same method, no 3-D Secure (a customer who topped up the account also reads as retry). Not recorded = recovered before this was measured."
    >
      <div className="xp-sum" style={{ margin: 0, fontSize: 13 }}>
        <span>
          Recovered <b>{formatCount(outcomes.recovered)}</b>
          {outcomes.recoveryRate != null ? (
            <span style={{ marginLeft: 6 }}>{`(${formatPercent(outcomes.recoveryRate)} of ${formatCount(outcomes.closed)} closed)`}</span>
          ) : null}
        </span>
        <span>Lost <b>{formatCount(outcomes.lost)}</b></span>
        <span>Still open <b>{formatCount(outcomes.open)}</b></span>
        <span>
          Median time to recover <b>{days(outcomes.medianDaysToRecover)}</b>
          {outcomes.recoveredWithTiming > 0 ? (
            <span style={{ marginLeft: 6 }}>{`(n=${formatCount(outcomes.recoveredWithTiming)})`}</span>
          ) : null}
        </span>
      </div>
      {outcomes.recoveryRate == null ? (
        <p className="xp-note">
          {`Fewer than ${MIN_SEQUENCES_FOR_RATE} sequences have closed, so no rate is shown. Read the counts.`}
        </p>
      ) : null}
      <p className="xp-sum" style={{ fontSize: 13 }}>
        <span>Customer fixed it <b>{formatCount(by.customer)}</b></span>
        <span>Silent retry <b>{formatCount(by.retry)}</b></span>
        <span>Unknown <b>{formatCount(by.unknown)}</b></span>
        <span>Not recorded <b>{formatCount(by.not_recorded)}</b></span>
      </p>
    </ChartFrame>
  );
}

/**
 * Subscription deletions by month, split by Stripe's cancellation_details.reason.
 * payment_failed is churn nobody chose: the card ran out of retries.
 */
function InvoluntaryChurn({
  months,
  reasonColumn,
  error,
}: {
  months: ChurnMonth[];
  reasonColumn: boolean;
  error: string | null;
}) {
  return (
    <ChartFrame
      title="Involuntary share of churn"
      subtitle="Subscriptions deleted each month (UTC), by why Stripe ended them."
      footnote="The reason is recorded from 2026-10-24 on. Earlier deletions are counted but show as not recorded, and the share is taken over deletions with a recorded reason only. Other is payment_disputed or no reason at all."
    >
      {error ? (
        <p className="xp-note xp-sum-bad">{`Deletions could not be read: ${error}`}</p>
      ) : !reasonColumn ? (
        <p className="xp-note xp-sum-bad">
          Migration 20261024225000 has not been applied, so no reason has been recorded yet. Counting starts once it is.
        </p>
      ) : null}
      {months.length === 0 ? (
        error ? null : <p className="xp-note">No subscription has been deleted yet.</p>
      ) : (
        <>
          <table className="ac-table xp-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Payment failed</th>
                <th scope="col">Cancelled</th>
                <th scope="col">Other</th>
                <th scope="col">Not recorded</th>
                <th scope="col">Involuntary</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{formatCount(m.payment_failed)}</td>
                  <td>{formatCount(m.cancellation_requested)}</td>
                  <td>{formatCount(m.other)}</td>
                  <td>{formatCount(m.not_recorded)}</td>
                  <td>{m.involuntaryShare != null ? formatPercent(m.involuntaryShare) : NO_DATA}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="xp-hint">{`No share in a month with fewer than ${MIN_SEQUENCES_FOR_RATE} deletions that have a recorded reason.`}</p>
        </>
      )}
    </ChartFrame>
  );
}

/**
 * Does the in-product surface do anything the email does not? Clicks on the
 * failed-payment banner's button, next to the number of dunning sequences.
 * The MCP chat notice is not counted: payment_notice_shown goes to the edge
 * function logs only, and no table holds it.
 */
function BannerReach({
  clicks,
  error,
  outcomes,
}: {
  clicks: FixClickSummary | null;
  error: string | null;
  outcomes: OutcomeSummary;
}) {
  return (
    <ChartFrame
      title="Banner reach"
      subtitle="Clicks on the dashboard's failed-payment button (payment_fix_clicked)."
      footnote="Sent on to Stripe = the open invoice page, or the billing portal when there was none. Bounced = no customer, or a Stripe error, so the owner landed on settings. The chat notice (payment_notice_shown) is logged to edge function logs only, so it is not counted here."
    >
      {error ? (
        <p className="xp-note xp-sum-bad">{`Clicks could not be read: ${error}`}</p>
      ) : clicks ? (
        <div className="xp-sum" style={{ margin: 0, fontSize: 13 }}>
          <span>Clicks <b>{formatCount(clicks.clicks)}</b></span>
          <span>Sent on to Stripe <b>{formatCount(clicks.sentToStripe)}</b></span>
          <span className={clicks.bounced > 0 ? 'xp-sum-bad' : undefined}>
            Bounced <b>{formatCount(clicks.bounced)}</b>
          </span>
          <span>Workspaces <b>{formatCount(clicks.workspaces)}</b></span>
          <span>Dunning sequences <b>{formatCount(outcomes.sequences)}</b></span>
          <span><b>Last click:</b> {when(clicks.lastClickAt)}</span>
        </div>
      ) : null}
    </ChartFrame>
  );
}

/** Which of the nine emails actually go out, and which never get there. */
function ByTemplate({ summary }: { summary: DunningSummary }) {
  const rows = summary.byTemplate;
  return (
    <ChartFrame
      title="By email"
      subtitle="Where a sequence gets to before it is cancelled."
      footnote="A high cancelled count on the later dunning emails is the feature working: the card recovered, or the subscription closed, before day 7 came round."
    >
      {rows.length === 0 ? (
        <p className="xp-note">Nothing has been queued yet.</p>
      ) : (
        <table className="ac-table xp-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Sent</th>
              <th scope="col">Waiting</th>
              <th scope="col">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.template}>
                <th scope="row">
                  {row.template}
                  <span className="xp-control-tag">{TEMPLATE_WORDS[row.template] ?? ''}</span>
                </th>
                <td>{formatCount(row.sent)}</td>
                <td>{formatCount(row.pending)}</td>
                <td>{formatCount(row.cancelled)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ChartFrame>
  );
}

/**
 * Cancellations, broken out by reason.
 *
 * Grouped because "cancelled" hides two opposite outcomes inside one number.
 * `payment_recovered` is the feature succeeding. `suppressed` and
 * `undeliverable` are emails somebody was meant to get and did not, and they
 * must not be able to sit inside a total that looks like good news.
 */
function WhyCancelled({ summary }: { summary: DunningSummary }) {
  const BAD = new Set(['suppressed', 'undeliverable']);
  return (
    <ChartFrame
      title="Why they were cancelled"
      subtitle="The same total, split by what actually happened."
      footnote="payment_recovered and subscription_reactivated are the feature working. suppressed and undeliverable are emails that were meant to arrive and did not."
    >
      {summary.cancelReasons.length === 0 ? (
        <p className="xp-note">Nothing has been cancelled yet.</p>
      ) : (
        <table className="ac-table xp-table">
          <thead>
            <tr>
              <th scope="col">Reason</th>
              <th scope="col">Rows</th>
            </tr>
          </thead>
          <tbody>
            {summary.cancelReasons.map((row) => (
              <tr key={row.reason}>
                <th scope="row" className={BAD.has(row.reason) ? 'xp-sum-bad' : undefined}>{row.reason}</th>
                <td>{formatCount(row.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ChartFrame>
  );
}

/**
 * The rows nothing will retry again.
 *
 * `claim_billing_emails` stops handing a row out after five attempts, so a row
 * that reaches it will sit unsent forever. That is the correct behaviour and it
 * is also the one state that needs a person, which is why it gets its own
 * panel rather than a count inside a total.
 */
function NeedsAPerson({ summary, rows }: { summary: DunningSummary; rows: DunningRow[] }) {
  const recipientFor = (scope: string) => {
    const hit = rows.find((r) => r.scope_key === scope);
    return hit ? maskAddress(hit.recipient) : NO_DATA;
  };

  return (
    <ChartFrame
      title="Needs a person"
      subtitle="Rows that have exhausted their retries and will not be picked up again."
      footnote="Five failed attempts is where claim_billing_emails stops. These are not lost, they are parked: fix the cause and reset attempts to zero to release them."
    >
      {summary.stuck.length === 0 ? (
        <p className="xp-note">Nothing is stuck. Every queued email is either waiting for its date or finished.</p>
      ) : (
        <table className="ac-table xp-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">About</th>
              <th scope="col">To</th>
              <th scope="col">Due since</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {summary.stuck.map((row) => (
              <tr key={`${row.template}:${row.scope}`}>
                <th scope="row">{row.template}</th>
                <td>{row.scope}</td>
                <td>{recipientFor(row.scope)}</td>
                <td>{when(row.dueSince)}</td>
                <td>{formatCount(row.attempts)}</td>
                <td>{row.lastError ?? NO_DATA}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ChartFrame>
  );
}
