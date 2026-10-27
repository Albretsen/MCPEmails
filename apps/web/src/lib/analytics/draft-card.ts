/**
 * The draft card release read-out: is the card used, and does it hurt or help?
 *
 * Pure arithmetic over growth_draft_card_stats rows, so the band and its tests
 * agree on what each rate means. Data: draft_events
 * (supabase/functions/mcp-server/draft-events.ts), customer workspaces only.
 *
 * NO HOLDOUT. Everyone gets the card at once, so nothing here is a controlled
 * comparison. Two stand-ins, each with a known bias:
 *   - BEFORE vs AFTER the release, in the clients that draw the card. Season
 *     and growth move both halves.
 *   - CARD CLIENTS vs the rest (Cursor, Codex and the like, which draw no
 *     card), after the release. Different people use different clients.
 * When both point the same way, believe it. When they disagree, it is too
 * early or the effect is small.
 */

import type { GrowthDraftCardReachRow, GrowthDraftCardStatsRow } from './growth-types';

/**
 * When the card went on for every workspace, as an ISO timestamp, or null
 * before that: the minute 20261027160000_draft_editor_for_everyone.sql ran in
 * production.
 */
export const DRAFT_CARD_RELEASE_AT: string | null = '2026-10-27T09:57:00Z';

export type Family = GrowthDraftCardStatsRow['family'];

/** The clients that draw the card. Claude Code draws it in the desktop Code tab only. */
export const CARD_FAMILIES: readonly Family[] = ['claude', 'chatgpt', 'claude_code'];

export const FAMILY_NAMES: Record<Family, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  claude_code: 'Claude Code',
  other: 'Other clients',
};

/** Below this many card drafts since the release, the checks say "too early". */
export const MIN_CARD_DRAFTS = 100;

export type Totals = Omit<GrowthDraftCardStatsRow, 'period' | 'family'>;

const ZERO: Totals = {
  drafted: 0,
  drafted_card: 0,
  card_lines: 0,
  saved: 0,
  sent_card: 0,
  sent_agent: 0,
  deleted_card: 0,
  deleted_agent: 0,
  hidden: 0,
  workspaces: 0,
  card_workspaces: 0,
  calls: 0,
  errors: 0,
  eligible_card: 0,
  returned_card: 0,
  eligible_plain: 0,
  returned_plain: 0,
};

/** Sum the rows that match. PostgREST returns bigint as number or string. */
export function totals(
  rows: GrowthDraftCardStatsRow[],
  period: 'before' | 'after',
  families: readonly Family[],
): Totals {
  const out = { ...ZERO };
  for (const row of rows) {
    if (row.period !== period || !families.includes(row.family)) continue;
    for (const key of Object.keys(ZERO) as (keyof Totals)[]) out[key] += Number(row[key]) || 0;
  }
  return out;
}

const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export type Rates = {
  /** Of the drafts that carried the card, the share saved, sent or discarded in it. */
  touched: number | null;
  /** Sends per new draft. Can pass 1 when old drafts are sent. */
  sent: number | null;
  /** Of the sends, the share made from the card. */
  sentFromCard: number | null;
  /** Discards per new draft. */
  discarded: number | null;
  /** Share of draft tool calls that failed. */
  errors: number | null;
  /** Came back 7 to 14 days after their first draft. */
  returnedCard: number | null;
  returnedPlain: number | null;
};

export function rates(t: Totals): Rates {
  return {
    touched: rate(t.card_lines, t.drafted_card),
    sent: rate(t.sent_card + t.sent_agent, t.drafted),
    sentFromCard: rate(t.sent_card, t.sent_card + t.sent_agent),
    discarded: rate(t.deleted_card + t.deleted_agent, t.drafted),
    errors: rate(t.errors, t.calls),
    returnedCard: rate(t.returned_card, t.eligible_card),
    returnedPlain: rate(t.returned_plain, t.eligible_plain),
  };
}

export type CheckState = 'pass' | 'fail' | 'wait';

export type Check = {
  key: string;
  question: string;
  bar: string;
  state: CheckState;
  detail: string;
};

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

/**
 * The bars the release is judged on. Proposed 2026-10-27 for the release, not
 * derived from data; move them here if they turn out wrong.
 */
export const BARS = {
  /** At least this share of card drafts touched in the card. */
  touched: 0.1,
  /** The send rate in card clients may drop at most this much, relative. */
  sendDrop: 0.1,
  /** At most this share of workspaces that have the card turn it off. */
  optOut: 0.05,
  /** Draft tool failure rate may rise at most this many points. */
  errorRise: 0.01,
} as const;

/**
 * Four checks that decide keep or pull, plus one that only informs.
 * `wait` until there are MIN_CARD_DRAFTS card drafts since the release.
 */
export function releaseChecks(
  rows: GrowthDraftCardStatsRow[],
  reach: GrowthDraftCardReachRow | null,
  released: boolean,
): Check[] {
  const before = rates(totals(rows, 'before', CARD_FAMILIES));
  const afterTotals = totals(rows, 'after', CARD_FAMILIES);
  const after = rates(afterTotals);
  const otherBefore = rates(totals(rows, 'before', ['other']));
  const otherAfter = rates(totals(rows, 'after', ['other']));
  const enough = released && afterTotals.drafted_card >= MIN_CARD_DRAFTS;
  const judge = (ok: boolean | null): CheckState => (!enough || ok === null ? 'wait' : ok ? 'pass' : 'fail');

  const enabled = Number(reach?.enabled ?? 0);
  const optOut = enabled > 0 ? Number(reach?.hidden_workspaces ?? 0) / enabled : null;

  // Change in the card clients' send rate, net of the change in other clients
  // over the same dates when they have data, so a quiet week is not blamed on
  // the card.
  const change = (b: number | null, a: number | null) => (b !== null && a !== null && b > 0 ? a / b - 1 : null);
  const cardChange = change(before.sent, after.sent);
  const otherChange = change(otherBefore.sent, otherAfter.sent);
  const netChange = cardChange === null ? null : cardChange - (otherChange ?? 0);

  return [
    {
      key: 'used',
      question: 'Do people use it?',
      bar: `${pct(BARS.touched)}+ of card drafts touched in the card`,
      state: judge(after.touched === null ? null : after.touched >= BARS.touched),
      detail: `${pct(after.touched)} of ${afterTotals.drafted_card} card drafts`,
    },
    {
      key: 'harm',
      question: 'Are as many drafts sent?',
      bar: `send rate down no more than ${pct(BARS.sendDrop)}, net of other clients`,
      state: judge(netChange === null ? null : netChange >= -BARS.sendDrop),
      detail: `${pct(before.sent)} before, ${pct(after.sent)} after${otherChange === null ? '' : `; other clients ${otherChange >= 0 ? '+' : ''}${pct(otherChange)}`}`,
    },
    {
      key: 'rejected',
      question: 'Do people turn it off?',
      bar: `under ${pct(BARS.optOut)} of workspaces`,
      state: judge(optOut === null ? null : optOut < BARS.optOut),
      detail: `${reach?.hidden_workspaces ?? 0} of ${enabled} workspaces, ${reach?.hidden_inboxes ?? 0} inboxes`,
    },
    {
      key: 'broken',
      question: 'Does it break drafting?',
      bar: `draft tool failures up no more than ${(BARS.errorRise * 100).toFixed(0)} point`,
      state: judge(
        before.errors === null || after.errors === null ? null : after.errors - before.errors <= BARS.errorRise,
      ),
      detail: `${pct(before.errors)} before, ${pct(after.errors)} after`,
    },
    {
      key: 'retention',
      question: 'Do card users come back more? (informs only)',
      bar: 'card users return at least as often',
      state: 'wait',
      detail: `${pct(after.returnedCard)} of card users vs ${pct(after.returnedPlain)} of others came back 7 to 14 days later (people who try a new thing are keener anyway)`,
    },
  ];
}

export type ReleaseVerdict = { level: 'ok' | 'degraded' | 'down' | 'unknown'; headline: string; reason: string };

export function releaseVerdict(checks: Check[], released: boolean): ReleaseVerdict {
  if (!released) {
    return {
      level: 'unknown',
      headline: 'Not released',
      reason: 'Showing the baseline: the last window of drafts before the card. Set DRAFT_CARD_RELEASE_AT on release.',
    };
  }
  // A failure is said as soon as it shows; a check only fails once there is
  // enough data, so it is never a verdict on a handful of drafts.
  const decisive = checks.filter((c) => c.key !== 'retention');
  const failed = decisive.filter((c) => c.state === 'fail');
  if (failed.length > 0) {
    return {
      level: failed.some((c) => c.key === 'harm' || c.key === 'broken') ? 'down' : 'degraded',
      headline: 'Look closer',
      reason: `Failing: ${failed.map((c) => c.question).join(' ')}`,
    };
  }
  if (decisive.some((c) => c.state === 'wait')) {
    return {
      level: 'unknown',
      headline: 'Too early',
      reason: `Judged once ${MIN_CARD_DRAFTS} customer drafts have carried the card.`,
    };
  }
  return { level: 'ok', headline: 'Keep it', reason: 'All four checks pass.' };
}
