/**
 * One row in public.inbox_autofill_lookups per server-side autofill answer, so
 * the hit rate is read from production (inbox_autofill_scoreboard) rather than
 * replayed against today's DNS.
 *
 * Called after the response, never awaited by it, and never throws: logging is
 * worth nothing next to the form filling in. The DOMAIN only, never an address.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

export type AutofillSurface = 'connect_modal' | 'onboarding';
export type AutofillLogSource = 'table' | 'srv' | 'mx' | 'ispdb' | 'ispdb_mx' | 'none' | 'timeout';

const SOURCES: readonly string[] = ['table', 'srv', 'mx', 'ispdb', 'ispdb_mx', 'none', 'timeout'];

export interface AutofillLookup {
  surface: AutofillSurface;
  domain: string;
  source: string | null | undefined;
  kind?: string | null;
  imapHost?: string | null;
  smtpHost?: string | null;
}

type Row = Database['public']['Tables']['inbox_autofill_lookups']['Insert'];

function host(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  return trimmed && trimmed.length <= 253 ? trimmed : null;
}

/** The row to insert, narrowed to what the table's checks accept. */
export function autofillLookupRow(userId: string, lookup: AutofillLookup): Row | null {
  const domain = lookup.domain.trim().toLowerCase();
  if (!userId || !domain || domain.length > 253) return null;
  const source = (SOURCES.includes(String(lookup.source)) ? lookup.source : 'none') as AutofillLogSource;
  const kind = typeof lookup.kind === 'string' && lookup.kind.length <= 40 ? lookup.kind : null;
  return {
    user_id: userId,
    surface: lookup.surface,
    domain,
    source,
    kind,
    imap_host: host(lookup.imapHost),
    smtp_host: host(lookup.smtpHost),
  };
}

export async function logAutofillLookup(
  client: () => SupabaseClient<Database>,
  userId: string,
  lookup: AutofillLookup,
): Promise<void> {
  const row = autofillLookupRow(userId, lookup);
  if (!row) return;
  try {
    const { error } = await client().from('inbox_autofill_lookups').insert(row);
    if (error) console.warn('[autofill-log] insert failed:', error.message);
  } catch (err) {
    console.warn('[autofill-log] insert failed:', err instanceof Error ? err.message : String(err));
  }
}
