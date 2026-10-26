// ---------------------------------------------------------------------------
// usage-meter-note.ts - onboarding Flow B, B3 (WP-H). Two things the Free
// allowance says in the chat, for workspaces in onb_convert = on only
// (v1: internal accounts; the database decides, onboarding_convert_on()):
//
//   (b) ONE short line appended to a SUCCESSFUL tool result when the
//       workspace reaches 80% of its monthly Free allowance, and one more on
//       the call that uses the last action (100%). Once per level per billing
//       period: claim_usage_meter_note() is the claim and the funnel row.
//   (c) The cap refusal opens with what the user got done this month (reads,
//       drafts, sends from action_usage), then the existing upgrade path,
//       with the annual price as the second option.
//
// THIS IS A DELIBERATE, GATED EXCEPTION to usage-limit-message.ts's "nothing
// is appended to successful results" rule, asked for by the onboarding plan
// (section 5, B3) and limited to the Flow B arm. Everything else about that
// file's reasoning still holds and is kept here:
//   - Declarative facts only, never an instruction to the model.
//   - OpenAI clients (ChatGPT, Codex; `directory` wording) never get a plan
//     name, a price or an upgrade link: their line is the usage fact alone.
//   - It can never fail or slow a call that is not in the band: no query
//     unless this reservation landed at or past 80% of the cap, and every
//     error is swallowed and logged.
//   - The chat-checkout-link experiment is untouched: its arms decide whether
//     a link is minted, exactly as before. (c) only adds a first sentence and
//     an annual sentence around whichever arm's text was chosen.
// ---------------------------------------------------------------------------

import {
  FREE_CAP_UPGRADE_PRICE,
  type PlanLimitWording,
} from "./usage-limit-message.ts";

/** Personal yearly, as printed on /pricing (plans.ts yearlyPriceCents 8640). */
export const FREE_CAP_UPGRADE_ANNUAL_PRICE = "$86.40 per year";

/** The `from=` tag on the usage line's link, so the funnel can tell this door apart. */
export const USAGE_METER_PRICING_PATH = "/pricing?from=usage_meter";

/** The levels the chat line speaks at. The dashboard meter also shows 50%. */
export type ChatMeterLevel = 80 | 100;

/** What a successful reservation knew, enough to decide and word the line. */
export interface MeterReading {
  plan: string;
  usedActions: number;
  cap: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * 100 on the call that used the last action, 80 from 80% of the cap, else
 * null. `usedActions` counts this call's own reservation.
 */
export function usageMeterLevel(usedActions: number, cap: number): ChatMeterLevel | null {
  if (!Number.isFinite(usedActions) || !Number.isFinite(cap) || cap <= 0) return null;
  if (usedActions >= cap) return 100;
  if (usedActions >= Math.ceil(0.8 * cap)) return 80;
  return null;
}

/**
 * The line itself. Facts first (count, cap, reset date), then for non-OpenAI
 * clients the plan that removes the cap with both prices and one link.
 */
export function buildUsageMeterNote(
  level: ChatMeterLevel,
  reading: Pick<MeterReading, "usedActions" | "cap" | "periodEnd">,
  wording: PlanLimitWording,
  appOrigin: string,
): string {
  const used = Math.min(reading.usedActions, reading.cap).toLocaleString("en-US");
  const cap = reading.cap.toLocaleString("en-US");
  const resetDate = reading.periodEnd.slice(0, 10);
  const fact = level === 100
    ? `MCPEmails usage: this request used the last of the ${cap} email actions the Free plan includes this month. ` +
      `Further email actions are refused until the counter resets on ${resetDate}.`
    : `MCPEmails usage: ${used} of the ${cap} email actions the Free plan includes this month are used. ` +
      `The counter resets on ${resetDate}.`;
  if (wording === "directory") return fact;
  return `${fact} The Personal plan removes the monthly cap for ${FREE_CAP_UPGRADE_PRICE} or ` +
    `${FREE_CAP_UPGRADE_ANNUAL_PRICE}: ${appOrigin}${USAGE_METER_PRICING_PATH}`;
}

/** The slice of the Supabase client the claim and the summary use. */
export interface UsageMeterDb {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): any;
}

/** Decide, claim, attach. Never throws. True when the line was attached. */
export async function maybeAttachUsageMeterNote(options: {
  db: UsageMeterDb;
  workspaceId: string;
  reading: MeterReading | null | undefined;
  succeeded: boolean;
  /** Only called once a line is claimed: the OpenAI test costs a query. */
  wording: () => Promise<PlanLimitWording>;
  appOrigin: string;
  attach: (note: string) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<boolean> {
  const log = options.log ?? ((event, fields) => console.log(`[mcp-server] ${event}`, fields));
  try {
    const reading = options.reading;
    if (!options.succeeded || !reading || reading.plan !== "free") return false;
    const level = usageMeterLevel(reading.usedActions, reading.cap);
    if (level === null) return false;
    const { data, error } = await options.db.rpc("claim_usage_meter_note", {
      p_workspace_id: options.workspaceId,
      p_level: level,
      p_period_start: reading.periodStart,
    });
    if (error) throw new Error(error.message ?? String(error));
    if (data !== true) return false;
    const wording = await options.wording();
    options.attach(buildUsageMeterNote(level, reading, wording, options.appOrigin));
    log("usage_meter_note_shown", { workspace_id: options.workspaceId, level, wording });
    return true;
  } catch (err) {
    log("usage_meter_note_failed", {
      workspace_id: options.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** This period's reads, drafts and sends, from usage_month_summary(). */
export interface MonthSummary {
  reads: number;
  drafts: number;
  sends: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/**
 * "This month MCPEmails read 42 emails, wrote 12 drafts and sent 5 emails for
 * this workspace." Null when there is nothing to say (all zero).
 */
export function buildMonthSummarySentence(summary: MonthSummary | null | undefined): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.reads > 0) parts.push(`read ${plural(summary.reads, "email", "emails")}`);
  if (summary.drafts > 0) parts.push(`wrote ${plural(summary.drafts, "draft", "drafts")}`);
  if (summary.sends > 0) parts.push(`sent ${plural(summary.sends, "email", "emails")}`);
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `This month MCPEmails ${list} for this workspace.`;
}

/** The annual price as the second option, for non-OpenAI wordings only. */
export function annualOptionSentence(wording: PlanLimitWording, appOrigin: string): string {
  if (wording === "directory") return "";
  return ` Personal is also ${FREE_CAP_UPGRADE_ANNUAL_PRICE} when paid yearly, at ${appOrigin}/pricing.`;
}

/**
 * The Flow B framing of a Free cap refusal: the month's achievements first,
 * then the existing text unchanged, then the annual option. `summary` null
 * (not convert, or the read failed) returns the text exactly as it was.
 */
export function frameCapRefusal(
  text: string,
  summary: MonthSummary | null | undefined,
  wording: PlanLimitWording,
  appOrigin: string,
): string {
  if (!summary) return text;
  const lead = buildMonthSummarySentence(summary);
  return `${lead ? `${lead} ` : ""}${text}${annualOptionSentence(wording, appOrigin)}`;
}

/**
 * Read the month summary for a refused Free call. Null unless the workspace
 * is in Flow B (the function answers zeros otherwise; zeros and a convert-on
 * workspace with nothing done are told apart by onboarding_convert_on()).
 * Never throws.
 */
export async function loadCapSummary(
  db: UsageMeterDb,
  workspaceId: string,
  periodStart: string,
  log: (event: string, fields: Record<string, unknown>) => void = (e, f) => console.log(`[mcp-server] ${e}`, f),
): Promise<MonthSummary | null> {
  try {
    const gate = await db.rpc("onboarding_convert_on", { p_workspace_id: workspaceId });
    if (gate.error) throw new Error(gate.error.message ?? String(gate.error));
    if (gate.data !== true) return null;
    const { data, error } = await db.rpc("usage_month_summary", { p_workspace_id: workspaceId, p_since: periodStart });
    if (error) throw new Error(error.message ?? String(error));
    const row = Array.isArray(data) ? data[0] : data;
    return {
      reads: Number(row?.reads) || 0,
      drafts: Number(row?.drafts) || 0,
      sends: Number(row?.sends) || 0,
    };
  } catch (err) {
    log("cap_summary_failed", { workspace_id: workspaceId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
