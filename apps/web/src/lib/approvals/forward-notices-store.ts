/**
 * The Supabase side of src/lib/approvals/forward-notices.ts. Service role only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { deliveryReasonFromDetail, loadScheduledSendsByApproval, provablyNotSent, type DeliveryReason } from '@/lib/approvals/delivery';
import { readSummary } from '@/lib/approvals/payload';
import type { Database, Json } from '@/types/database.types';
import {
  EXPIRES_SOON_MS,
  type ClaimedNotice,
  type FailedForwards,
  type NoticeFinish,
  type NoticeRecipient,
  type NoticeStore,
  type WaitingForwards,
} from '@/lib/approvals/forward-notices';

/** Far above what a person can review; the count stays exact below it. */
const WAITING_READ_LIMIT = 500;

export class SupabaseForwardNoticeStore implements NoticeStore {
  constructor(private readonly db: SupabaseClient<Database>) {}

  async claim(limit: number): Promise<ClaimedNotice[]> {
    const { data, error } = await this.db.rpc('claim_forward_approval_notices', { p_limit: limit });
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: row.id,
      workspace_id: row.workspace_id,
      triage_rule_id: row.triage_rule_id,
      no_approval_rule_id: row.no_approval_rule_id,
      kind: (['reminder', 'receipt', 'coverage_paused', 'failed'] as const).find((kind) => kind === row.kind) ?? 'queued',
      attempts: row.attempts,
    }));
  }

  async ruleName(ruleId: string): Promise<string | null> {
    const { data, error } = await this.db.from('triage_rules').select('name').eq('id', ruleId).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.name ?? null;
  }

  async waiting(ruleId: string): Promise<WaitingForwards | null> {
    const { data, error } = await this.db
      .from('send_approvals')
      .select('summary, expires_at')
      .eq('triage_rule_id', ruleId)
      .eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: true })
      .limit(WAITING_READ_LIMIT);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) return null;
    const addresses = new Set<string>();
    const shapes = new Set<string>();
    for (const row of rows) {
      const to = readSummary(row.summary).to;
      const own = Array.isArray(to) ? to.filter((address): address is string => typeof address === 'string' && Boolean(address)) : [];
      own.forEach((address) => addresses.add(address));
      shapes.add([...own].map((address) => address.trim().toLowerCase()).sort().join(','));
    }
    const soonBefore = Date.now() + EXPIRES_SOON_MS;
    return {
      count: rows.length,
      addresses: [...addresses],
      deadline: rows[0].expires_at as string,
      expiringSoon: rows.filter((row) => Date.parse(row.expires_at as string) <= soonBefore).length,
      addressesVary: shapes.size > 1,
    };
  }

  async receipt(noticeId: string) {
    const { data, error } = await this.db
      .from('send_approvals')
      .select('summary, no_approval_rule_name, decided_at')
      .eq('receipt_notice_id', noticeId)
      .order('decided_at', { ascending: true })
      .limit(WAITING_READ_LIMIT);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) return null;
    const addresses = new Set<string>();
    for (const row of rows) {
      const to = readSummary(row.summary).to;
      if (Array.isArray(to)) {
        for (const address of to) if (typeof address === 'string' && address) addresses.add(address);
      }
    }
    return { count: rows.length, addresses: [...addresses], noApprovalRuleName: rows[0].no_approval_rule_name ?? null };
  }

  async failed(noticeId: string, workspaceId: string): Promise<FailedForwards | null> {
    const { data, error } = await this.db
      .from('send_approvals')
      .select('id, summary, triage_rule_id, decided_at')
      .eq('failed_notice_id', noticeId)
      .limit(WAITING_READ_LIMIT);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) return null;
    const ruleIds = [...new Set(rows.map((row) => row.triage_rule_id).filter((id): id is string => Boolean(id)))];
    const { data: liveRules, error: rulesError } = await this.db
      .from('triage_rules').select('id').in('id', ruleIds).is('deleted_at', null);
    if (rulesError) throw new Error(rulesError.message);
    const live = new Set((liveRules ?? []).map((rule) => rule.id));
    const markers = await loadScheduledSendsByApproval(this.db, workspaceId, rows.map((row) => row.id));
    const addresses = new Set<string>();
    const reasons = new Set<DeliveryReason>();
    let canRetry = 0;
    let mayHaveSent = 0;
    for (const row of rows) {
      const to = readSummary(row.summary).to;
      if (Array.isArray(to)) {
        for (const address of to) if (typeof address === 'string' && address) addresses.add(address);
      }
      const marker = markers.get(row.id);
      reasons.add(deliveryReasonFromDetail(marker?.error_detail));
      if (!provablyNotSent(marker)) mayHaveSent += 1;
      else if (row.triage_rule_id && live.has(row.triage_rule_id)) canRetry += 1;
    }
    return {
      count: rows.length,
      addresses: [...addresses],
      canRetry,
      mayHaveSent,
      reason: reasons.size === 1 ? [...reasons][0] : null,
    };
  }

  async noApprovalRuleName(ruleId: string): Promise<string | null> {
    const { data, error } = await this.db.from('no_approval_rules').select('name').eq('id', ruleId).maybeSingle();
    if (error) throw new Error(error.message);
    return data?.name ?? null;
  }

  async recipients(workspaceId: string, category: string): Promise<NoticeRecipient[]> {
    const { data: workspace, error: workspaceError } = await this.db
      .from('workspaces')
      .select('id')
      .eq('id', workspaceId)
      .is('deleted_at', null)
      .maybeSingle();
    if (workspaceError) throw new Error(workspaceError.message);
    if (!workspace) return [];

    const { data: members, error: membersError } = await this.db
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .in('role', ['owner', 'admin']);
    if (membersError) throw new Error(membersError.message);
    const ids = (members ?? []).map((member) => member.user_id);
    if (ids.length === 0) return [];

    const { data: users, error: usersError } = await this.db
      .from('users')
      .select('id, email, unsubscribe_token, unsubscribed_categories')
      .in('id', ids)
      .is('deleted_at', null);
    if (usersError) throw new Error(usersError.message);
    return (users ?? [])
      .filter((user) => !(user.unsubscribed_categories ?? []).includes(category))
      .map((user) => ({ userId: user.id, email: user.email, unsubscribeToken: user.unsubscribe_token }));
  }

  async finish(id: string, outcome: NoticeFinish): Promise<void> {
    const { error } = await this.db
      .from('forward_approval_notices')
      .update({
        status: outcome.status,
        error: outcome.status === 'sent' ? null : outcome.error.slice(0, 120),
        sent_at: outcome.status === 'sent' ? new Date().toISOString() : null,
      })
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  async logEvent(event: { status: 'sent' | 'failed'; error: string | null; payload: Record<string, unknown> }): Promise<void> {
    // Written directly and already processed: emit_system_event would post to
    // system-notify, which mails the operator. The audit trail is what is wanted.
    const { error } = await this.db.from('system_events').insert({
      event_type: 'automation.forward_notice',
      payload: event.payload as { [key: string]: Json | undefined },
      status: event.status,
      error: event.error?.slice(0, 120) ?? null,
      processed_at: new Date().toISOString(),
    });
    if (error) console.error('[forward-notices] system event not written:', error.message);
  }
}
