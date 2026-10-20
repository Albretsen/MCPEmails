import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import type { AliasRow, SendAsInbox, SendAsStore } from '@/lib/inboxes/send-as';

const COLUMNS =
  'id, inbox_id, workspace_id, email_address, display_name, verified_at, code_hash, code_expires_at, code_attempts, code_sent_at, created_at';

/**
 * The Supabase store behind lib/inboxes/send-as.ts.
 *
 * Takes the SERVICE-ROLE client: authenticated has no write grant on
 * inbox_sender_aliases and cannot read code_hash (20261018120000). The route
 * has already authenticated the caller, proved the inbox is in one of their
 * workspaces and checked their role, so every query here is scoped to that
 * inbox id AND its workspace id, the same two keys the inbox routes use.
 */
export function createSendAsStore(db: SupabaseClient<Database>): SendAsStore {
  const table = () => db.from('inbox_sender_aliases');
  return {
    async list(inbox: SendAsInbox) {
      const { data, error } = await table()
        .select(COLUMNS)
        .eq('inbox_id', inbox.id)
        .eq('workspace_id', inbox.workspace_id)
        .order('created_at', { ascending: true });
      if (error) throw new Error(`send-as list failed: ${error.message}`);
      return (data ?? []) as AliasRow[];
    },

    async get(inbox: SendAsInbox, aliasId: string) {
      const { data, error } = await table()
        .select(COLUMNS)
        .eq('id', aliasId)
        .eq('inbox_id', inbox.id)
        .eq('workspace_id', inbox.workspace_id)
        .maybeSingle();
      if (error) throw new Error(`send-as get failed: ${error.message}`);
      return (data ?? null) as AliasRow | null;
    },

    async isConnectedInbox(workspaceId: string, address: string) {
      const { data, error } = await db
        .from('inboxes')
        .select('id')
        .eq('workspace_id', workspaceId)
        .ilike('email_address', address.replace(/[\\%_]/g, (c) => `\\${c}`))
        .eq('status', 'active')
        .is('deleted_at', null)
        .limit(1);
      if (error) throw new Error(`send-as inbox lookup failed: ${error.message}`);
      return (data ?? []).length > 0;
    },

    async insert(inbox: SendAsInbox, row) {
      const { data, error } = await table()
        .insert({
          inbox_id: inbox.id,
          // The trigger sets this from the inbox regardless; sent so the insert
          // satisfies NOT NULL before the trigger runs on any Postgres version.
          workspace_id: inbox.workspace_id,
          email_address: row.email_address,
          display_name: row.display_name,
          created_by: row.created_by,
        })
        .select(COLUMNS)
        .single();
      if (error || !data) throw new Error(`send-as insert failed: ${error?.message ?? 'no row'}`);
      return data as AliasRow;
    },

    async update(inbox: SendAsInbox, aliasId: string, patch: Partial<AliasRow>) {
      // Never let a patch move the row: these two are the scope.
      const { inbox_id: _i, workspace_id: _w, id: _id, ...safe } = patch;
      const { error } = await table()
        .update(safe)
        .eq('id', aliasId)
        .eq('inbox_id', inbox.id)
        .eq('workspace_id', inbox.workspace_id);
      if (error) throw new Error(`send-as update failed: ${error.message}`);
    },

    async remove(inbox: SendAsInbox, aliasId: string) {
      const { data, error } = await table()
        .delete()
        .eq('id', aliasId)
        .eq('inbox_id', inbox.id)
        .eq('workspace_id', inbox.workspace_id)
        .select('id');
      if (error) throw new Error(`send-as delete failed: ${error.message}`);
      return (data ?? []).length > 0;
    },
  };
}
