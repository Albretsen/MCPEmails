#!/usr/bin/env node
/**
 * Classify every workspace that predates workspaces.acquisition_email_segment.
 *
 *   node --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *     scripts/backfill-email-segment.mjs            # dry run: counts only
 *   ... scripts/backfill-email-segment.mjs --apply  # write the column
 *
 * Run from apps/web.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (for example `vercel env pull` into a file you then source).
 *
 * WHY A SCRIPT AND NOT SQL IN THE MIGRATION. The segment must be the line the
 * paywall draws, and that line is emailSegment() in
 * src/lib/segment/consumer-domains.mjs. A second consumer-domain list in SQL
 * would drift from it, and the whole point of the column is that a GROUP BY on
 * it means exactly what the product did. New workspaces are stamped by the
 * dashboard (src/lib/segment/record-segment.ts) with the same function.
 *
 * Classifies by the OWNER's account email, first write wins (rows that already
 * have a value are never touched), and prints counts per segment only. It never
 * prints an address or a domain.
 */
import { createServiceRoleClient } from '../src/lib/supabase/service.ts';
import { emailSegment } from '../src/lib/segment/consumer-domains.mjs';

const apply = process.argv.includes('--apply');
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  process.exit(1);
}
const db = createServiceRoleClient();

// Owner emails, from auth. Paged; the admin API caps a page at 1000.
const emailById = new Map();
for (let page = 1; ; page += 1) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  for (const user of data.users) emailById.set(user.id, user.email ?? null);
  if (data.users.length < 1000) break;
}

// Unclassified workspaces. PostgREST truncates silently at its row limit, so
// page explicitly rather than trusting one select.
const rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('workspaces')
    .select('id, owner_id')
    .is('acquisition_email_segment', null)
    .order('created_at', { ascending: true })
    .range(from, from + 999);
  if (error) throw error;
  rows.push(...data);
  if (data.length < 1000) break;
}

const counts = { business: 0, consumer: 0, academic: 0, unknown: 0 };
let written = 0;
for (const row of rows) {
  const segment = emailSegment(emailById.get(row.owner_id));
  counts[segment] += 1;
  if (!apply) continue;
  const { error } = await db
    .from('workspaces')
    .update({ acquisition_email_segment: segment })
    .eq('id', row.id)
    .is('acquisition_email_segment', null);
  if (error) {
    console.error(`workspace ${row.id}: ${error.message}`);
    continue;
  }
  written += 1;
}

console.log(`${rows.length} unclassified workspaces`);
for (const [segment, n] of Object.entries(counts)) console.log(`  ${segment.padEnd(9)} ${n}`);
console.log(apply ? `wrote ${written}` : 'dry run: nothing written (pass --apply to write)');
