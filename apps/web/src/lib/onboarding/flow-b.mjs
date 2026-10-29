/**
 * Onboarding Flow B (onb_convert = on): the three calm payment moments. Pure
 * functions, no React, so the /onboarding panels and the dashboard Overview
 * decide the same way and the rules are testable without mounting anything.
 * Plan section 5 (Documents/plans/onboarding-research-20261026.md), WP-H.
 *
 * Rules for every moment, from the plan:
 *   - only after a win (a first real tool call), never a blocking modal;
 *   - "Continue on Free" as visible as the paid choice;
 *   - monthly preselected, annual beside it;
 *   - the reassurance line (CheckoutReassurance) under every buy button;
 *   - no countdowns, no discounts, no card-first trial.
 *
 *   B1  "Connect your other inbox" on It works (ItWorksStep). At the Free
 *       inbox cap the tap opens the dashboard's existing upgrade panel
 *       (ConnectModal, entry point `second_inbox`); otherwise it goes back
 *       to the inbox step.
 *   B2  The plan summary card, at the end of onboarding and on the Overview
 *       for the first 3 days (`showPlanSummary`).
 *   B3  (a) the grace-end note (`graceEndNote`), (b) the usage meter at
 *       50/80/100% (`usageMeterLevel`), (c) the cap result in chat
 *       (supabase/functions/mcp-server/usage-meter-note.ts).
 *
 * `flowB` is the server-built prop both surfaces receive (null unless
 * convert is on and the workspace is on Free), see flow-b-server.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after signup the Overview keeps the plan summary. */
export const PLAN_SUMMARY_DAYS = 3;
/** How long after the grace ends the Overview keeps the one grace-end note. */
export const GRACE_NOTE_DAYS = 7;
/** The dashboard meter levels, in order. The chat line uses 80 and 100 only. */
export const USAGE_METER_LEVELS = Object.freeze([50, 80, 100]);

function ms(value) {
  if (value == null) return NaN;
  const t = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Which plan the card recommends. A work domain gets Pro (it is what an
 * operator with several company mailboxes needs, the same rule as
 * inboxCapOffer); a consumer who already tried a second inbox gets Personal;
 * anyone else gets no badge, both plans plain.
 *
 * @param {{ businessShaped?: boolean, triedSecondInbox?: boolean }} context
 * @returns {'solo' | 'personal' | null}
 */
export function recommendPlan({ businessShaped = false, triedSecondInbox = false } = {}) {
  if (businessShaped === true) return 'solo';
  if (triedSecondInbox === true) return 'personal';
  return null;
}

/**
 * B2 on the Overview: convert on, Free, after the first call, not dismissed,
 * and within PLAN_SUMMARY_DAYS of signup.
 *
 * @param {{ flowB?: object | null, now?: number }} input
 */
export function showPlanSummary({ flowB, now = Date.now() } = {}) {
  if (!flowB || flowB.plan !== 'free') return false;
  if (flowB.summaryDismissedAt) return false;
  if (!flowB.firstCallAt) return false;
  const created = ms(flowB.createdAt);
  if (!Number.isFinite(created)) return false;
  return now - created < PLAN_SUMMARY_DAYS * DAY_MS;
}

/**
 * The days the workspace was active during the grace, from the daily call
 * series the dashboard already holds (`usageData.dailyCounts`, UTC dates).
 *
 * @param {Array<{ date: string, count: number }>} dailyCounts
 * @param {string} createdAt
 * @param {string} graceEndsAt
 */
export function activeGraceDays(dailyCounts, createdAt, graceEndsAt) {
  const start = ms(createdAt);
  const end = ms(graceEndsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Array.isArray(dailyCounts)) return 0;
  const firstDay = new Date(start).toISOString().slice(0, 10);
  const lastDay = new Date(end).toISOString().slice(0, 10);
  let days = 0;
  for (const entry of dailyCounts) {
    const date = typeof entry?.date === 'string' ? entry.date.slice(0, 10) : '';
    if (!date || date < firstDay || date > lastDay) continue;
    if ((Number(entry.count) || 0) > 0) days += 1;
  }
  return days;
}

/**
 * B3a, the one in-product note when the grace has ended: null, or what it
 * says. Convert on, a metered Free workspace past its grace, within
 * GRACE_NOTE_DAYS of the end, not dismissed, and only for someone who used
 * the product in the grace (zero active days has nothing to tell).
 *
 * @param {{
 *   flowB?: object | null,
 *   allowance?: { exempt?: boolean, plan?: string, in_grace?: boolean, grace_ends_at?: string | null } | null,
 *   dailyCounts?: Array<{ date: string, count: number }>,
 *   now?: number,
 * }} input
 * @returns {null | { days: number, today: boolean, since: string }}
 */
export function graceEndNote({ flowB, allowance, dailyCounts = [], now = Date.now() } = {}) {
  if (!flowB || flowB.plan !== 'free' || flowB.graceNoteSeenAt) return null;
  if (!allowance || allowance.exempt || allowance.plan !== 'free' || allowance.in_grace) return null;
  const end = ms(allowance.grace_ends_at);
  if (!Number.isFinite(end) || now < end || now - end > GRACE_NOTE_DAYS * DAY_MS) return null;
  const days = activeGraceDays(dailyCounts, flowB.createdAt, allowance.grace_ends_at);
  if (days < 1) return null;
  const since = new Date(end).toISOString().slice(0, 10);
  return { days, today: new Date(now).toISOString().slice(0, 10) === since, since };
}

/**
 * B3b, the dashboard meter level: the highest of 50/80/100 reached, or null.
 * Takes the progress object from allowance-view.mjs (`allowanceProgress`),
 * which is null for every workspace that is not metered.
 *
 * @param {{ used: number, cap: number } | null | undefined} progress
 * @returns {50 | 80 | 100 | null}
 */
export function usageMeterLevel(progress) {
  if (!progress || !(progress.cap > 0)) return null;
  const ratio = progress.used / progress.cap;
  if (ratio >= 1) return 100;
  if (ratio >= 0.8) return 80;
  if (ratio >= 0.5) return 50;
  return null;
}

/**
 * B1: is the next inbox past the plan's cap? `maxInboxes` null is unlimited.
 *
 * @param {number} inboxCount
 * @param {number | null | undefined} maxInboxes
 */
export function nextInboxNeedsUpgrade(inboxCount, maxInboxes) {
  if (maxInboxes == null) return false;
  return (Number(inboxCount) || 0) >= maxInboxes;
}

export { SECOND_INBOX_DASHBOARD_HREF } from './second-inbox.mjs';

/**
 * The card's prices from the live Stripe map (getPrices.ts): monthly always,
 * yearly only when a yearly price is configured (never an annual button that
 * can only fail).
 *
 * @param {Record<string, { monthlyCents: number | null, yearlyCents: number | null, yearlyPriceConfigured?: boolean }> | null | undefined} stripePrices
 * @param {'personal' | 'solo'} plan
 * @returns {{ monthlyCents: number, yearlyCents: number | null } | null}
 */
export function summaryPrice(stripePrices, plan) {
  const entry = stripePrices?.[plan];
  if (!entry || !(Number(entry.monthlyCents) > 0)) return null;
  const yearly = entry.yearlyPriceConfigured && Number(entry.yearlyCents) > 0 ? Number(entry.yearlyCents) : null;
  return { monthlyCents: Number(entry.monthlyCents), yearlyCents: yearly };
}

/** "$9" / "$86.40": whole dollars without cents. */
export function formatUsd(cents) {
  const value = Number(cents) / 100;
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** The funnel events Flow B writes through POST /api/onboarding {action: 'flow_b'}. */
export const FLOW_B_EVENTS = Object.freeze([
  'second_inbox_prompt_shown',
  'second_inbox_prompt_clicked',
  'plan_summary_shown',
  'plan_summary_dismissed',
  'plan_summary_clicked',
  'usage_meter_shown',
  'grace_end_note_shown',
  'grace_end_note_dismissed',
]);

export const FLOW_B_SURFACES = Object.freeze(['onboarding', 'overview']);

/**
 * What one `flow_b` action writes, or null for anything malformed. Pure, so
 * the route and its test agree on the vocabulary (migration
 * 20261026233917_onboarding_flow_b.sql holds the CHECK values).
 *
 *   stage     the product_funnel_events stage, or null (stamp only)
 *   category  the row's category
 *   stamp     a workspaces column to set to now(), or null
 *   dedupe    'ever': one row per workspace and category; 'since': one row
 *             per workspace and category since `since` (a billing period
 *             start); null: every event is a row
 *
 * @param {Record<string, unknown>} body
 * @returns {null | { stage: string | null, category: string, stamp: string | null, dedupe: 'ever' | 'since' | null, since: string | null }}
 */
export function parseFlowBEvent(body) {
  const event = body?.event;
  if (typeof event !== 'string' || !FLOW_B_EVENTS.includes(event)) return null;
  const surface = FLOW_B_SURFACES.includes(body?.surface) ? body.surface : null;
  const surfaceCategory = surface ? `surface_${surface}` : null;
  switch (event) {
    case 'second_inbox_prompt_shown':
      return { stage: event, category: 'surface_onboarding', stamp: null, dedupe: 'ever', since: null };
    case 'second_inbox_prompt_clicked':
      return { stage: event, category: 'surface_onboarding', stamp: null, dedupe: null, since: null };
    case 'plan_summary_shown':
      return surfaceCategory ? { stage: event, category: surfaceCategory, stamp: null, dedupe: 'ever', since: null } : null;
    case 'plan_summary_dismissed':
      return surfaceCategory ? { stage: event, category: surfaceCategory, stamp: 'plan_summary_dismissed_at', dedupe: null, since: null } : null;
    case 'plan_summary_clicked': {
      const plan = body?.plan;
      if (plan !== 'free' && plan !== 'personal' && plan !== 'solo') return null;
      // "Continue on Free" is an answer, and it hides the card for good.
      return { stage: event, category: plan, stamp: plan === 'free' ? 'plan_summary_dismissed_at' : null, dedupe: null, since: null };
    }
    case 'usage_meter_shown': {
      const level = Number(body?.level);
      const since = typeof body?.since === 'string' && Number.isFinite(Date.parse(body.since)) ? new Date(body.since).toISOString() : null;
      if (!USAGE_METER_LEVELS.includes(level) || !since) return null;
      return { stage: event, category: `level_${level}`, stamp: null, dedupe: 'since', since };
    }
    case 'grace_end_note_shown':
      return { stage: event, category: 'unknown', stamp: null, dedupe: 'ever', since: null };
    case 'grace_end_note_dismissed':
      return { stage: null, category: 'unknown', stamp: 'grace_end_note_seen_at', dedupe: null, since: null };
    default:
      return null;
  }
}
