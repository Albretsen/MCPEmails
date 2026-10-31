/**
 * Where a held send came from: an automation rule, or an AI assistant's call.
 *
 * Either column marks a rule forward, because the id goes null when the rule row
 * is removed and the row is still a rule forward. Rows queued before the link
 * existed carry it only if the backfill found their run item.
 */
export const APPROVAL_RULE_LINK_COLUMNS = ['triage_rule_id', 'triage_rule_name'] as const;

export type ApprovalKind = 'rule_forward' | 'ai_send';

export function withApprovalOrigin<T extends Record<string, unknown>>(row: T) {
  const { triage_rule_id: ruleId, triage_rule_name: ruleName, ...rest } = row;
  const linked = typeof ruleId === 'string' || typeof ruleName === 'string';
  return {
    ...rest,
    kind: (linked ? 'rule_forward' : 'ai_send') as ApprovalKind,
    rule_id: typeof ruleId === 'string' ? ruleId : null,
    rule_name: typeof ruleName === 'string' ? ruleName : null,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
  };
}

/**
 * Who decided a row, for the "Recently decided" list.
 *
 *   none       Nobody did: it expired or was cancelled.
 *   person     A signed-in owner or admin (`decided_by`).
 *   automatic  No person, but a surface recorded a decision. Nothing writes this
 *              yet: rules that approve by themselves will flow through the same
 *              row, and the list must not call that a person's decision.
 */
export type ApprovalDecider = 'none' | 'person' | 'automatic';

export function approvalDecider(row: {
  status?: unknown;
  decided_by?: unknown;
  decided_via?: unknown;
}): ApprovalDecider {
  if (row.status !== 'approved' && row.status !== 'rejected') return 'none';
  if (typeof row.decided_by === 'string') return 'person';
  return typeof row.decided_via === 'string' && !PERSON_SURFACES.has(row.decided_via) ? 'automatic' : 'person';
}

/**
 * Surfaces only a person can use. A row decided on one with no `decided_by` (a
 * rejection in the assistant's card, for instance) was still a person's decision.
 */
const PERSON_SURFACES = new Set(['dashboard', 'review_page', 'mcp_app']);
