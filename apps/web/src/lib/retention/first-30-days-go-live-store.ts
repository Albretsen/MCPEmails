/**
 * Supabase side of the first-30-days go-live switch: retention_switches and
 * first30_dry_run_log (20261025040000_first30_auto_go_live.sql). Thin; every
 * rule is in first-30-days-go-live.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database, Json } from '@/types/database.types';
import { readAllPages } from '@/lib/retention/first-30-days-store';
import type { DecisionPatch, GoLiveStore, LogRow, SwitchRow } from '@/lib/retention/first-30-days-go-live';

type Db = SupabaseClient<Database>;
type LogInsert = Database['public']['Tables']['first30_dry_run_log']['Insert'];

export const SWITCH_KEY = 'first30';

/** Decisions the evaluation reads. The per-candidate wait/done/stop rows are not needed. */
export const EVIDENCE_DECISIONS = ['run_summary', 'mailbox_probe', 'would_draft', 'would_send', 'would_holdout'] as const;

/** LogRow to an insert row. Pure; exported for tests. */
export function toInsert(row: LogRow): LogInsert {
  return {
    run_at: row.runAt,
    run_id: row.runId,
    workspace_id: row.workspaceId,
    template: row.template,
    decision: row.decision,
    reason: row.reason ? row.reason.slice(0, 200) : null,
    recipient_matches_owner: row.recipientMatchesOwner,
    owner_internal: row.ownerInternal,
    subscription_active: row.subscriptionActive,
    first_paid_at: row.firstPaidAt,
    error: row.error ? row.error.slice(0, 300) : null,
    detail: (row.detail ?? null) as Json,
  };
}

export class SupabaseGoLiveStore implements GoLiveStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async readSwitch(): Promise<SwitchRow | null> {
    const { data, error } = await this.db
      .from('retention_switches')
      .select('key, mode, auto_go_live_at, decided_at, decision, decision_detail')
      .eq('key', SWITCH_KEY)
      .maybeSingle();
    if (error) throw new Error(`switch read failed: ${error.message}`);
    if (!data) return null;
    return {
      key: data.key,
      mode: data.mode === 'live' ? 'live' : 'dry_run',
      autoGoLiveAt: data.auto_go_live_at,
      decidedAt: data.decided_at,
      decision: data.decision === 'went_live' || data.decision === 'held' ? data.decision : null,
      decisionDetail: data.decision_detail,
    };
  }

  async appendLog(rows: LogRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await this.db.from('first30_dry_run_log').insert(rows.slice(i, i + 500).map(toInsert));
      if (error) throw new Error(`dry-run log insert failed: ${error.message}`);
    }
  }

  async lastProbeAt(): Promise<string | null> {
    const { data, error } = await this.db
      .from('first30_dry_run_log')
      .select('run_at')
      .eq('decision', 'mailbox_probe')
      .order('run_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`probe read failed: ${error.message}`);
    return data?.run_at ?? null;
  }

  async readEvidence(since: Date): Promise<LogRow[]> {
    const rows = await readAllPages(
      (from, to) =>
        this.db
          .from('first30_dry_run_log')
          .select(
            'run_at, run_id, workspace_id, template, decision, reason, recipient_matches_owner, owner_internal, subscription_active, first_paid_at, error, detail',
          )
          .in('decision', [...EVIDENCE_DECISIONS])
          .gte('run_at', since.toISOString())
          .order('run_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'dry-run evidence read',
    );
    return rows.map((r) => ({
      runAt: r.run_at,
      runId: r.run_id,
      workspaceId: r.workspace_id,
      template: r.template,
      decision: r.decision as LogRow['decision'],
      reason: r.reason,
      recipientMatchesOwner: r.recipient_matches_owner,
      ownerInternal: r.owner_internal,
      subscriptionActive: r.subscription_active,
      firstPaidAt: r.first_paid_at,
      error: r.error,
      detail: (r.detail ?? null) as Record<string, unknown> | null,
    }));
  }

  async decide(patch: DecisionPatch): Promise<boolean> {
    const { data, error } = await this.db
      .from('retention_switches')
      .update({
        mode: patch.mode,
        decision: patch.decision,
        decided_at: patch.decidedAt,
        decision_detail: patch.detail as Json,
        updated_at: patch.decidedAt,
      })
      .eq('key', SWITCH_KEY)
      .eq('mode', 'dry_run')
      .is('decision', null)
      .select('key');
    if (error) throw new Error(`decision write failed: ${error.message}`);
    return (data ?? []).length === 1;
  }

  async annotateDecision(extra: Record<string, unknown>): Promise<void> {
    const row = await this.readSwitch();
    const detail = { ...((row?.decisionDetail as Record<string, unknown> | null) ?? {}), ...extra };
    const { error } = await this.db
      .from('retention_switches')
      .update({ decision_detail: detail as Json })
      .eq('key', SWITCH_KEY);
    if (error) throw new Error(`decision annotate failed: ${error.message}`);
  }

  async pruneLog(before: Date): Promise<void> {
    const { error } = await this.db.from('first30_dry_run_log').delete().lt('run_at', before.toISOString());
    if (error) throw new Error(`dry-run log prune failed: ${error.message}`);
  }
}
