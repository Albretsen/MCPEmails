/**
 * The Supabase side of the activation help emails. Thin on purpose: every
 * decision lives in activation-help.ts, which is tested against an in-memory
 * store. This file only reads rows and writes the ledger.
 *
 * READS ARE SEQUENTIAL and batched by workspace id with `.in()`. Any read that
 * can return many rows is paged with `.range()` on a total order, because
 * PostgREST stops at 1000 rows without an error.
 *
 * THE HOST. A generic IMAP failure row in product_funnel_events carries no
 * host by design. The connect route also logs the failure to app_errors with
 * `context.imapHost` and `context.workspaceId`, so the latest such row is read
 * to tell "IONOS typed into Other" from an unknown server. The host only picks
 * which body to send; it is never printed or stored.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { accountState } from '@/lib/billing/deleted-account';
import { isSuppressed } from '@/lib/email/lifecycle';
import { matchesInternal } from '@/lib/email/paywall-followup-store';
import type {
  ActivationHelpEmail,
  ActivationHelpStore,
  CandidateContext,
  ClaimRow,
  ConnectionRow,
  LedgerRow,
} from '@/lib/email/activation-help';
import { E1_MAX_AGE_MS, TEMPLATES } from '@/lib/email/activation-help';

type Db = SupabaseClient<Database>;
type LedgerUpdate = Database['public']['Tables']['lifecycle_email_sends']['Update'];

const CHUNK = 100;
const PAGE = 1000;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Read every page of a query. `page(from, to)` must apply a total order. */
async function readAll<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${label} read failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const EVENT_STAGES = ['inbox_connection', 'first_tool_call', 'technical_activation', 'credential_created', 'client_selected'];

export class SupabaseActivationHelpStore implements ActivationHelpStore {
  private readonly db: Db;
  private internalEmails: Set<string> | null = null;

  constructor(db: Db) {
    this.db = db;
  }

  async listCandidateIds(since: Date, startAt: Date): Promise<string[]> {
    const ids = new Set<string>();
    const sinceIso = since.toISOString();

    const events = await readAll('connection event', (from, to) =>
      this.db
        .from('product_funnel_events')
        .select('id, workspace_id')
        .eq('stage', 'inbox_connection')
        .in('outcome', ['success', 'failure'])
        .gte('occurred_at', sinceIso)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const e of events) ids.add(e.workspace_id);

    const connected = await readAll('connected workspace', (from, to) =>
      this.db
        .from('workspaces')
        .select('id')
        .gte('analytics_first_inbox_connected_at', sinceIso)
        .gte('created_at', startAt.toISOString())
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const w of connected) ids.add(w.id);

    const inboxes = await readAll('new inbox', (from, to) =>
      this.db
        .from('inboxes')
        .select('id, workspace_id')
        .gte('created_at', sinceIso)
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const i of inboxes) ids.add(i.workspace_id);

    return [...ids];
  }

  private async internal(): Promise<Set<string>> {
    if (this.internalEmails) return this.internalEmails;
    const { data, error } = await this.db.from('internal_accounts').select('email');
    if (error) throw new Error(`internal account read failed: ${error.message}`);
    this.internalEmails = new Set((data ?? []).map((r) => r.email.toLowerCase()));
    return this.internalEmails;
  }

  async loadContexts(workspaceIds: string[]): Promise<CandidateContext[]> {
    if (workspaceIds.length === 0) return [];
    const listed = await this.internal();
    const out: CandidateContext[] = [];

    for (const ids of chunks(workspaceIds)) {
      const { data: wsRows, error: wsError } = await this.db
        .from('workspaces')
        .select(
          'id, owner_id, created_at, deleted_at, acquisition_locale, onboarding_client, analytics_first_inbox_connected_at, analytics_first_credential_created_at, analytics_first_tool_used_at',
        )
        .in('id', ids);
      if (wsError) throw new Error(`workspace read failed: ${wsError.message}`);
      const workspaces = new Map((wsRows ?? []).map((w) => [w.id, w]));

      const ownerIds = [...new Set((wsRows ?? []).map((w) => w.owner_id))];
      const owners = new Map<string, { id: string; email: string | null; unsubscribed_at: string | null; unsubscribed_categories: string[] | null; unsubscribe_token: string | null }>();
      if (ownerIds.length) {
        const { data, error } = await this.db
          .from('users')
          .select('id, email, unsubscribed_at, unsubscribed_categories, unsubscribe_token')
          .in('id', ownerIds);
        if (error) throw new Error(`owner read failed: ${error.message}`);
        for (const o of data ?? []) owners.set(o.id, o);
      }

      const events = await readAll('funnel event', (from, to) =>
        this.db
          .from('product_funnel_events')
          .select('id, workspace_id, stage, outcome, category, error_category, phase, auth_reason, occurred_at')
          .in('workspace_id', ids)
          .in('stage', EVENT_STAGES)
          .order('id', { ascending: true })
          .range(from, to),
      );

      const inboxRows = await readAll('inbox', (from, to) =>
        this.db
          .from('inboxes')
          .select('id, workspace_id, created_at')
          .in('workspace_id', ids)
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .range(from, to),
      );

      // Latest generic IMAP connect error per workspace, inside the E1 window.
      const hosts = new Map<string, { host: string; at: string }>();
      const { data: errorRows, error: errorsError } = await this.db
        .from('app_errors')
        .select('context, created_at')
        .eq('context->>route', 'api/inboxes/imap')
        .in('context->>workspaceId', ids)
        .gte('created_at', new Date(Date.now() - E1_MAX_AGE_MS - 3_600_000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1000);
      if (errorsError) {
        // The host only refines the wording; without it the email is keyed on the provider.
        console.error('[activation-help] connect error read failed:', errorsError.message);
      }
      for (const row of errorRows ?? []) {
        const ctx = row.context as Record<string, unknown> | null;
        const ws = typeof ctx?.workspaceId === 'string' ? ctx.workspaceId : null;
        const host = typeof ctx?.imapHost === 'string' ? ctx.imapHost : null;
        if (ws && host && !hosts.has(ws)) hosts.set(ws, { host, at: row.created_at });
      }

      const { data: ledgerRows, error: ledgerError } = await this.db
        .from('lifecycle_email_sends')
        .select('trigger_key, template, status')
        .in('trigger_key', ids)
        .in('template', Object.values(TEMPLATES));
      if (ledgerError) throw new Error(`ledger read failed: ${ledgerError.message}`);

      for (const id of ids) {
        const w = workspaces.get(id) ?? null;
        const o = w ? owners.get(w.owner_id) ?? null : null;
        const own = events.filter((e) => e.workspace_id === id);
        const connections: ConnectionRow[] = own
          .filter((e) => e.stage === 'inbox_connection')
          .map((e) => ({
            outcome: e.outcome,
            occurredAt: e.occurred_at,
            category: e.category,
            errorCategory: e.error_category,
            phase: e.phase,
            authReason: e.auth_reason,
          }));
        const clientRows = own
          .filter((e) => e.stage === 'client_selected')
          .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
        const live = inboxRows.filter((i) => i.workspace_id === id);
        const firstLive = live.map((i) => i.created_at).sort()[0] ?? null;
        const ledger: LedgerRow[] = (ledgerRows ?? [])
          .filter((r) => r.trigger_key === id)
          .map((r) => ({ template: r.template, status: r.status }));

        out.push({
          workspaceId: id,
          workspace: w
            ? {
                ownerId: w.owner_id,
                createdAt: w.created_at,
                deletedAt: w.deleted_at,
                acquisitionLocale: w.acquisition_locale,
                onboardingClient: w.onboarding_client,
                firstInboxConnectedAt: w.analytics_first_inbox_connected_at,
                firstCredentialCreatedAt: w.analytics_first_credential_created_at,
                firstToolUsedAt: w.analytics_first_tool_used_at,
              }
            : null,
          owner: o
            ? {
                id: o.id,
                email: o.email,
                unsubscribedAt: o.unsubscribed_at,
                unsubscribedCategories: o.unsubscribed_categories ?? [],
                unsubscribeToken: o.unsubscribe_token,
              }
            : null,
          accountState: null,
          internal: matchesInternal(o?.email ?? null, listed),
          connections,
          firstLiveInboxAt: firstLive,
          liveInboxCount: live.length,
          calledEvent: own.some((e) => e.stage === 'first_tool_call' || e.stage === 'technical_activation'),
          credentialEvent: own.some((e) => e.stage === 'credential_created' && e.outcome === 'success'),
          latestClientSelected: clientRows[0]?.category ?? null,
          failureHost: hosts.get(id)?.host ?? null,
          ledger,
        });
      }
    }

    return out;
  }

  async accountState(userId: string): Promise<'live' | 'deleted' | 'unknown'> {
    return accountState(this.db, userId);
  }

  async isSuppressed(userId: string): Promise<boolean> {
    return isSuppressed(this.db, userId, 'lifecycle');
  }

  async claim(row: ClaimRow): Promise<boolean> {
    // upsert + ignoreDuplicates is INSERT ... ON CONFLICT DO NOTHING. A clash
    // on the per-workspace partial unique index raises instead, which is also
    // a claim we did not win.
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .upsert(
        {
          user_id: row.userId,
          template: TEMPLATES[row.email],
          trigger_key: row.workspaceId,
          email: row.address,
          status: row.status,
          detail: row.detail,
          ...(row.status === 'holdout' ? { finished_at: new Date().toISOString() } : {}),
        },
        { onConflict: 'user_id,template,trigger_key', ignoreDuplicates: true },
      )
      .select('user_id');
    if (error) {
      console.error('[activation-help] claim failed:', error.message);
      return false;
    }
    return (data ?? []).length === 1;
  }

  async finish(
    key: { userId: string; workspaceId: string; email: ActivationHelpEmail },
    outcome: { status: 'sent'; providerId: string | null } | { status: 'failed'; detail: string },
  ): Promise<void> {
    const patch: LedgerUpdate = {
      status: outcome.status,
      provider_message_id: outcome.status === 'sent' ? outcome.providerId : null,
      finished_at: new Date().toISOString(),
      ...(outcome.status === 'failed' ? { detail: outcome.detail.slice(0, 500) } : {}),
    };
    const { error } = await this.db
      .from('lifecycle_email_sends')
      .update(patch)
      .eq('user_id', key.userId)
      .eq('template', TEMPLATES[key.email])
      .eq('trigger_key', key.workspaceId)
      .eq('status', 'claimed');
    if (error) {
      // The row stays 'claimed', which also means "never again" for this
      // workspace, so the failure direction is still "no second send".
      console.error('[activation-help] could not finish ledger row:', error.message);
    }
  }
}
