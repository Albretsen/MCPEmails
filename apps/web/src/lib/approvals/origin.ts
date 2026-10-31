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
