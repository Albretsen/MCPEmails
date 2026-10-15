/**
 * Ticket submission: validate, rate-limit, store, then send.
 *
 * ROW FIRST, THEN SEND. The row is the ticket; the emails are notifications
 * about it. If the insert fails the visitor gets a 500 and nothing is sent
 * (we have nothing to point a ref at). If a send fails the visitor still gets
 * their 201 and ref: the row is in `support_tickets` with `notified_at` or
 * `confirmation_sent_at` left NULL, which is the query that finds tickets
 * whose emails never went out.
 *
 * Everything with I/O is injected (`TicketDeps`) so the whole flow, status
 * codes included, is testable without a network; the route wires the real
 * dependencies with createSupportTicketDeps().
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database, Json } from '@/types/database.types';

import { EMPTY_TICKET_CONTEXT, type TicketContext } from '@/lib/support/context';
import type { TicketEmailInput } from '@/lib/support/emails';
import { isRateLimited, type TicketCounter } from '@/lib/support/rate-limit';
import { validateTicketRequest, type SupportTicketErrorCode, type ValidTicket } from '@/lib/support/validation';

export interface StoredTicket {
  id: string;
  ref: string;
}

export interface TicketStore extends TicketCounter {
  insert(row: {
    user_id: string | null;
    workspace_id: string | null;
    email: string;
    category: string;
    subject: string;
    message: string;
    context: TicketContext;
    source: string;
    ip_hash: string | null;
  }): Promise<StoredTicket | null>;
  markSent(id: string, fields: { notified_at?: string; confirmation_sent_at?: string }): Promise<void>;
}

export interface TicketDeps {
  store: TicketStore;
  loadContext(userId: string): Promise<TicketContext>;
  sendTicket(input: TicketEmailInput): Promise<boolean>;
  sendConfirmation(input: { ref: string; email: string }): Promise<boolean>;
  now(): number;
}

export type TicketResponseBody =
  | { ok: true; ref: string | null }
  | { ok: false; error: SupportTicketErrorCode | 'rate_limited' | 'server_error' };

export interface TicketOutcome {
  status: 200 | 201 | 400 | 429 | 500;
  body: TicketResponseBody;
}

export async function submitSupportTicket(
  input: { rawBody: string; user: { id: string; email: string } | null; ipHash: string | null },
  deps: TicketDeps,
): Promise<TicketOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_json' } };
  }

  const nowMs = deps.now();
  const result = validateTicketRequest(parsed, { sessionEmail: input.user?.email ?? null, nowMs });
  if (result.kind === 'drop') return { status: 200, body: { ok: true, ref: null } };
  if (result.kind === 'error') return { status: 400, body: { ok: false, error: result.error } };
  const ticket: ValidTicket = result.ticket;

  if (await isRateLimited(deps.store, { ipHash: input.ipHash, email: ticket.email, source: ticket.source, nowMs })) {
    return { status: 429, body: { ok: false, error: 'rate_limited' } };
  }

  // Context only for a signed-in user: a signed-out visitor is anyone, and
  // the email they typed proves nothing about which workspace is theirs.
  const base = input.user ? await deps.loadContext(input.user.id).catch(() => EMPTY_TICKET_CONTEXT) : EMPTY_TICKET_CONTEXT;
  const context: TicketContext = { ...base, from: ticket.from, provider: ticket.provider, code: ticket.code };

  let stored: StoredTicket | null = null;
  try {
    stored = await deps.store.insert({
      user_id: input.user?.id ?? null,
      workspace_id: context.workspace_id,
      email: ticket.email,
      category: ticket.category,
      subject: ticket.subject,
      message: ticket.message,
      context,
      source: ticket.source,
      ip_hash: input.ipHash,
    });
  } catch (err) {
    console.error('[support] ticket insert threw:', err instanceof Error ? err.message : String(err));
    stored = null;
  }
  if (!stored) return { status: 500, body: { ok: false, error: 'server_error' } };

  const emailInput: TicketEmailInput = {
    ref: stored.ref,
    email: ticket.email,
    category: ticket.category,
    subject: ticket.subject,
    message: ticket.message,
    source: ticket.source,
    context,
  };
  const [notified, confirmed] = await Promise.all([
    deps.sendTicket(emailInput).catch(() => false),
    deps.sendConfirmation({ ref: stored.ref, email: ticket.email }).catch(() => false),
  ]);

  const sentAt = new Date(deps.now()).toISOString();
  const fields: { notified_at?: string; confirmation_sent_at?: string } = {};
  if (notified) fields.notified_at = sentAt;
  if (confirmed) fields.confirmation_sent_at = sentAt;
  if (!notified) console.error(`[support] ${stored.ref} stored but the support notification was not sent`);
  if (fields.notified_at || fields.confirmation_sent_at) {
    await deps.store.markSent(stored.id, fields).catch((err: unknown) => {
      console.error('[support] markSent failed:', err instanceof Error ? err.message : String(err));
    });
  }

  return { status: 201, body: { ok: true, ref: stored.ref } };
}

/** The Supabase-backed store. Service-role client: the table has no policies. */
export function createSupabaseTicketStore(service: SupabaseClient<Database>): TicketStore {
  return {
    async count(filter, sinceIso) {
      let q = service.from('support_tickets').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
      if (filter.ipHash) q = q.eq('ip_hash', filter.ipHash);
      if (filter.email) q = q.eq('email', filter.email);
      if (filter.source) q = q.eq('source', filter.source);
      const { count, error } = await q;
      return error ? null : (count ?? 0);
    },
    async insert(row) {
      const { data, error } = await service
        .from('support_tickets')
        .insert({ ...row, context: row.context as unknown as Json })
        .select('id, ref')
        .single();
      if (error || !data) {
        console.error('[support] ticket insert failed:', error?.code ?? 'no_row');
        return null;
      }
      return { id: data.id, ref: data.ref };
    },
    async markSent(id, fields) {
      const { error } = await service.from('support_tickets').update(fields).eq('id', id);
      if (error) console.error('[support] markSent failed:', error.code);
    },
  };
}
