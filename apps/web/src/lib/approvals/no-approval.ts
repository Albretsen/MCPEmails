/**
 * No-approval rules: the addresses a person trusts to receive rule forwards without
 * waiting for approval. The decision itself lives in the database
 * (supabase/migrations/20261031230000_no_approval_rules.sql). This is the input
 * check for the dashboard routes and what the form says before saving.
 *
 * Safe for the browser: no server imports.
 */

export const NO_APPROVAL_DEFAULT_LIMIT = 25;
export const NO_APPROVAL_MAX_LIMIT = 100;
export const NO_APPROVAL_MAX_RECIPIENTS = 20;
export const NO_APPROVAL_MAX_NAME = 80;

/** `send_approvals.decided_via` of a row a no-approval rule decided. */
export const NO_APPROVAL_DECIDED_VIA = 'no_approval_rule';

/**
 * `no_approval_wait_reason` values that are about who sent the mail. A person has
 * to look at each of these: they are shown at the decision and never approved in
 * bulk (src/lib/approvals/approve-all.ts).
 */
export function hasSenderWarning(reason: unknown): boolean {
  return reason === 'sender_failed' || reason === 'sender_unverified';
}

/** The same test as public.no_approval_recipients_valid: one exact address, no wildcard. */
const EXACT_ADDRESS = /^[a-z0-9.!#$&'+^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export function isExactAddress(address: string): boolean {
  return address.length <= 254 && EXACT_ADDRESS.test(address);
}

/** Commas or new lines. Lowercased and deduplicated. */
export function parseExactAddresses(text: string): { addresses: string[]; invalid: string[] } {
  const parts = text.split(/[\s,;]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const addresses = [...new Set(parts)];
  return { addresses: addresses.filter(isExactAddress), invalid: addresses.filter((a) => !isExactAddress(a)) };
}

export type NoApprovalScope = 'all_automations' | 'chosen_automations';

export interface NoApprovalInput {
  name: string;
  recipients: string[];
  scope: NoApprovalScope;
  automation_ids: string[];
  /** null: every inbox. */
  inbox_ids: string[] | null;
  daily_limit: number;
  time_zone: string;
  verified_senders_only: boolean;
  enabled: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((id) => typeof id === 'string' && UUID.test(id)) ? [...new Set(value as string[])] : null;
}

export function validateNoApprovalInput(body: unknown):
  | { ok: true; value: NoApprovalInput }
  | { ok: false; code: string } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 1 || name.length > NO_APPROVAL_MAX_NAME) return { ok: false, code: 'invalid_name' };

  if (!Array.isArray(raw.recipients) || !raw.recipients.every((r) => typeof r === 'string')) {
    return { ok: false, code: 'invalid_recipients' };
  }
  const recipients = [...new Set((raw.recipients as string[]).map((r) => r.trim().toLowerCase()))];
  if (recipients.length < 1 || recipients.length > NO_APPROVAL_MAX_RECIPIENTS || !recipients.every(isExactAddress)) {
    return { ok: false, code: 'invalid_recipients' };
  }

  const scope = raw.scope;
  if (scope !== 'all_automations' && scope !== 'chosen_automations') return { ok: false, code: 'invalid_scope' };
  const automationIds = scope === 'chosen_automations' ? uuidList(raw.automation_ids) : [];
  if (automationIds === null) return { ok: false, code: 'invalid_automation' };
  if (scope === 'chosen_automations' && automationIds.length === 0) return { ok: false, code: 'automations_required' };

  let inboxIds: string[] | null = null;
  if (raw.inbox_ids !== null && raw.inbox_ids !== undefined) {
    inboxIds = uuidList(raw.inbox_ids);
    if (inboxIds === null || inboxIds.length === 0) return { ok: false, code: 'invalid_inbox' };
  }

  const limit = raw.daily_limit === undefined ? NO_APPROVAL_DEFAULT_LIMIT : raw.daily_limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > NO_APPROVAL_MAX_LIMIT) {
    return { ok: false, code: 'invalid_limit' };
  }

  const timeZone = typeof raw.time_zone === 'string' && raw.time_zone.length > 0 ? raw.time_zone : 'UTC';
  return {
    ok: true,
    value: {
      name,
      recipients,
      scope,
      automation_ids: automationIds,
      inbox_ids: inboxIds,
      daily_limit: limit,
      time_zone: timeZone.slice(0, 64),
      // On unless a person says off.
      verified_senders_only: raw.verified_senders_only !== false,
      enabled: raw.enabled === true,
    },
  };
}

/** The route's answer to a refusal from the write functions. */
export function noApprovalWriteError(error: { code?: string; message?: string }): { status: number; code: string } {
  if (error.code === '42501') return { status: 403, code: 'forbidden' };
  if (error.code === 'P0002') return { status: 404, code: 'not_found' };
  if (error.code === '22023' && typeof error.message === 'string' && error.message.startsWith('no_approval_')) {
    return { status: 400, code: error.message.slice('no_approval_'.length) };
  }
  return { status: 500, code: 'save_failed' };
}

/** Same content, same text, whatever order the keys were written in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

interface OverviewRule {
  id: string;
  recipients: string[];
  scope: NoApprovalScope;
  inbox_ids: string[] | null;
  enabled: boolean;
  paused_at: string | null;
  automations: { id: string; voided: boolean }[];
}

export type FormCoverage =
  /** Saved as it is on screen, it goes out without approval. */
  | 'covered'
  /** Covered until now, by chosen automations: saving this change stops that. */
  | 'voids_on_save'
  | 'waits';

/**
 * What the form says about the rule on screen, from the same list the page shows.
 * The server decides for real at run time. `changed` is false only when an existing
 * rule's filter, action and inbox are as saved. A new rule, a duplicate among them,
 * can only be covered by a rule for all automations.
 */
export function formCoverage(input: {
  overview: { paused_all?: boolean; rules?: OverviewRule[] } | null | undefined;
  ruleId: string | null;
  inboxId: string;
  to: readonly string[];
  changed: boolean;
}): FormCoverage {
  const rules = input.overview?.rules ?? [];
  const to = input.to.map((address) => address.trim().toLowerCase()).filter(Boolean);
  if (input.overview?.paused_all || to.length === 0) return 'waits';
  const live = rules.filter((rule) =>
    rule.enabled && !rule.paused_at && (rule.inbox_ids === null || rule.inbox_ids.includes(input.inboxId))
  );
  const covers = (group: OverviewRule[]) => to.every((address) => group.some((rule) => rule.recipients.includes(address)));
  const forAll = live.filter((rule) => rule.scope === 'all_automations');
  if (covers(forAll)) return 'covered';
  if (!input.ruleId) return 'waits';
  const chosen = live.filter((rule) =>
    rule.scope === 'chosen_automations' && rule.automations.some((a) => a.id === input.ruleId && !a.voided)
  );
  if (!covers([...forAll, ...chosen])) return 'waits';
  return input.changed ? 'voids_on_save' : 'covered';
}
