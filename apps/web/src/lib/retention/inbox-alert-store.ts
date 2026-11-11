/**
 * Supabase side of the broken-inbox alert (src/lib/retention/inbox-alert.ts).
 *
 * public.inbox_alert_sends, inbox_alert_candidates() and inbox_alert_readout()
 * come from 20261111140000_inbox_broken_alert.sql. Their entries in
 * database.types.ts were written in the generator's shape ahead of the apply;
 * `npm run gen:types` after applying should leave them unchanged. Rows are
 * still narrowed by hand below, because the generator types every column of a
 * set-returning function as non-null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { recordProductFunnelEvent } from '@/lib/analytics/product-funnel';
import {
  INBOX_ALERT_EXPERIMENT_KEY,
  ARM_HOLDOUT,
  subjectIdFor,
  type CandidateRow,
  type FunnelCategory,
  type FunnelStage,
  type InboxAlertArm,
  type InboxAlertStore,
  type InboxState,
  type LedgerRow,
  type NewLedgerRow,
} from '@/lib/retention/inbox-alert';

type Db = SupabaseClient<Database>;

const CHUNK = 200;
const PAGE = 1000;
const LEDGER_COLUMNS = 'id, inbox_id, workspace_id, break_started_at, phase, arm, status, attempts, created_at, sent_at, closed_at';

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toLedgerRow(r: Record<string, unknown>): LedgerRow {
  return {
    id: Number(r.id),
    inboxId: String(r.inbox_id),
    workspaceId: String(r.workspace_id),
    breakStartedAt: String(r.break_started_at),
    phase: Number(r.phase) === 2 ? 2 : 1,
    arm: r.arm === 'alert' ? 'alert' : 'holdout',
    status: (['claimed', 'sent', 'failed', 'holdout'] as const).find((s) => s === r.status) ?? 'failed',
    attempts: Number(r.attempts ?? 0),
    createdAt: String(r.created_at),
    sentAt: str(r.sent_at),
    closedAt: str(r.closed_at),
  };
}

export function toCandidateRow(r: Record<string, unknown>): CandidateRow | null {
  const inboxId = str(r.inbox_id);
  const workspaceId = str(r.workspace_id);
  const ownerId = str(r.owner_id);
  const ownerEmail = str(r.owner_email);
  const emailAddress = str(r.email_address);
  const provider = str(r.provider);
  const inboxStatus = str(r.inbox_status);
  if (!inboxId || !workspaceId || !ownerId || !ownerEmail || !emailAddress || !provider || !inboxStatus) return null;
  return {
    inboxId,
    workspaceId,
    ownerId,
    ownerEmail,
    plan: str(r.plan) ?? '',
    acquisitionLocale: str(r.acquisition_locale),
    emailAddress,
    provider,
    service: str(r.service),
    imapHost: str(r.imap_host),
    inboxStatus,
    lastError: str(r.last_error),
    errorRowAt: str(r.error_row_at),
    firstAuthFailedAt: str(r.first_auth_failed_at),
    lastAuthFailedAt: str(r.last_auth_failed_at),
    lastSuccessAt: str(r.last_success_at),
    lastClosedAt: str(r.last_closed_at),
  };
}

export class SupabaseInboxAlertStore implements InboxAlertStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async listCandidates(): Promise<CandidateRow[]> {
    const { data, error } = await this.db.rpc('inbox_alert_candidates', { p_lookback_days: 90 });
    if (error) throw new Error(`candidate read failed: ${error.message}`);
    return (data ?? []).map(toCandidateRow).filter((r): r is CandidateRow => r !== null);
  }

  async listOpenLedger(): Promise<LedgerRow[]> {
    const out: LedgerRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.db
        .from('inbox_alert_sends')
        .select(LEDGER_COLUMNS)
        .is('closed_at', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`ledger read failed: ${error.message}`);
      const rows = data ?? [];
      out.push(...rows.map(toLedgerRow));
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async loadInboxStates(inboxIds: string[]): Promise<Map<string, InboxState>> {
    const out = new Map<string, InboxState>();
    for (const ids of chunks(inboxIds)) {
      const { data, error } = await this.db
        .from('inboxes')
        .select('id, provider, status, last_error, deleted_at, parked_at')
        .in('id', ids);
      if (error) throw new Error(`inbox read failed: ${error.message}`);
      for (const r of data ?? []) {
        out.set(r.id, { provider: r.provider, status: r.status, lastError: r.last_error, deletedAt: r.deleted_at, parkedAt: r.parked_at });
      }
    }
    return out;
  }

  /**
   * Same precedence as the experiments library (src/lib/experiments/resolve.ts):
   * concluded serves the winner, draft serves variants[0] (the holdout),
   * running records the assignment once and returns the stored one.
   */
  async assignArm(workspaceId: string, proposed: InboxAlertArm): Promise<InboxAlertArm | null> {
    const { data, error } = await this.db
      .from('experiments')
      .select('status, winner_variant_id')
      .eq('key', INBOX_ALERT_EXPERIMENT_KEY)
      .maybeSingle();
    if (error || !data) {
      console.error('[inbox-alert] experiment unreadable:', error?.message ?? 'missing row');
      return null;
    }
    const narrow = (v: unknown): InboxAlertArm | null => (v === 'alert' || v === 'holdout' ? v : null);
    if (data.status === 'concluded') return narrow(data.winner_variant_id);
    if (data.status !== 'running') return ARM_HOLDOUT;
    const { data: stored, error: rpcError } = await this.db.rpc('experiment_assign', {
      p_key: INBOX_ALERT_EXPERIMENT_KEY,
      p_subject_id: subjectIdFor(workspaceId),
      p_variant_id: proposed,
    });
    if (rpcError) {
      console.error('[inbox-alert] assignment failed:', rpcError.message);
      return null;
    }
    return narrow(stored);
  }

  async insertRow(row: NewLedgerRow): Promise<LedgerRow | null> {
    const { data, error } = await this.db
      .from('inbox_alert_sends')
      .upsert(
        {
          inbox_id: row.inboxId,
          workspace_id: row.workspaceId,
          user_id: row.userId,
          break_started_at: row.breakStartedAt,
          phase: row.phase,
          arm: row.arm,
          status: row.status,
          provider: row.provider,
          attempts: row.status === 'claimed' ? 1 : 0,
        },
        { onConflict: 'inbox_id,break_started_at,phase', ignoreDuplicates: true },
      )
      .select(LEDGER_COLUMNS);
    if (error) {
      // Fail closed: an insert we cannot confirm is a claim we did not win.
      console.error('[inbox-alert] ledger insert failed:', error.message);
      return null;
    }
    const rows = data ?? [];
    return rows.length === 1 ? toLedgerRow(rows[0]) : null;
  }

  async reclaimRow(id: number, attempts: number): Promise<boolean> {
    const { data, error } = await this.db
      .from('inbox_alert_sends')
      .update({ status: 'claimed', attempts: attempts + 1 })
      .eq('id', id)
      .eq('attempts', attempts)
      .in('status', ['failed', 'claimed'])
      .select('id');
    if (error) {
      console.error('[inbox-alert] reclaim failed:', error.message);
      return false;
    }
    return (data ?? []).length === 1;
  }

  async finishRow(
    id: number,
    outcome: { status: 'sent'; providerMessageId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void> {
    const patch = outcome.status === 'sent'
      ? { status: 'sent', sent_at: new Date().toISOString(), provider_message_id: outcome.providerMessageId, detail: null }
      : { status: 'failed', detail: outcome.detail };
    const { error } = await this.db.from('inbox_alert_sends').update(patch).eq('id', id);
    if (error) console.error('[inbox-alert] ledger finish failed:', error.message);
  }

  async closeBreak(inboxId: string, breakStartedAt: string, reason: 'reconnected' | 'removed', at: Date): Promise<void> {
    const { error } = await this.db
      .from('inbox_alert_sends')
      .update({ closed_at: at.toISOString(), close_reason: reason })
      .eq('inbox_id', inboxId)
      .eq('break_started_at', breakStartedAt)
      .is('closed_at', null);
    if (error) throw new Error(`ledger close failed: ${error.message}`);
  }

  async recordFunnel(workspaceId: string, stage: FunnelStage, category: FunnelCategory): Promise<void> {
    await recordProductFunnelEvent(this.db, { workspaceId, stage, outcome: 'success', category });
  }
}

/** One row of public.inbox_alert_readout(). */
export interface ReadoutRow {
  arm: string;
  breaks: number;
  workspaces: number;
  firstSent: number;
  firstFailed: number;
  secondRows: number;
  mature: number;
  reconnected7d: number;
  reconnected7dMature: number;
  reconnectedAny: number;
  stillOpen: number;
}

export async function loadInboxAlertReadout(db: Db): Promise<ReadoutRow[]> {
  const { data, error } = await db.rpc('inbox_alert_readout');
  if (error) throw new Error(error.message);
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return (data ?? []).map((r) => ({
    arm: String(r.arm),
    breaks: n(r.breaks),
    workspaces: n(r.workspaces),
    firstSent: n(r.first_sent),
    firstFailed: n(r.first_failed),
    secondRows: n(r.second_rows),
    mature: n(r.mature),
    reconnected7d: n(r.reconnected_7d),
    reconnected7dMature: n(r.reconnected_7d_mature),
    reconnectedAny: n(r.reconnected_any),
    stillOpen: n(r.still_open),
  }));
}

/** The arm a workspace is in, for the dashboard banner. Null when not assigned or unreadable. */
export async function loadInboxAlertArm(db: Db, workspaceId: string): Promise<InboxAlertArm | null> {
  const { data, error } = await db
    .from('experiment_assignments')
    .select('variant_id')
    .eq('experiment_key', INBOX_ALERT_EXPERIMENT_KEY)
    .eq('subject_id', subjectIdFor(workspaceId))
    .maybeSingle();
  if (error || !data) return null;
  return data.variant_id === 'alert' || data.variant_id === 'holdout' ? data.variant_id : null;
}
