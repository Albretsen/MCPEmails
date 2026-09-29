/**
 * The Supabase side of Resend bounce/complaint handling. Every decision lives
 * in resend-webhook.ts; this only reads users and sets the existing opt-out.
 * Queries are sequential, never parallel.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import type { SuppressionStore } from '@/lib/email/resend-webhook';

type Db = SupabaseClient<Database>;

export class SupabaseSuppressionStore implements SuppressionStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async userIdsByEmail(addresses: string[]): Promise<string[]> {
    const variants = [...new Set(addresses.flatMap((a) => [a, a.toLowerCase()]))];
    const { data, error } = await this.db.from('users').select('id').in('email', variants);
    if (error) throw new Error(`user lookup failed: ${error.message}`);
    return (data ?? []).map((r) => r.id);
  }

  async userIdsByProviderMessageId(emailId: string): Promise<string[]> {
    const { data, error } = await this.db
      .from('lifecycle_email_sends')
      .select('user_id')
      .eq('provider_message_id', emailId);
    if (error) throw new Error(`ledger lookup failed: ${error.message}`);
    return (data ?? []).map((r) => r.user_id);
  }

  async suppress(userIds: string[], at: Date): Promise<number> {
    const { data, error } = await this.db
      .from('users')
      .update({ unsubscribed_at: at.toISOString() })
      .in('id', userIds)
      .is('unsubscribed_at', null)
      .select('id');
    if (error) throw new Error(`suppression write failed: ${error.message}`);
    return (data ?? []).length;
  }
}
