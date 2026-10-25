/**
 * The EUR launch dispatcher's two side channels, on the service-role client:
 * its state (rows in public.pricing_switches, service role only) and its
 * alerts (emit_system_event -> system-notify -> the owner's inbox, the same
 * pipeline as the signup and checkout-feedback mails).
 *
 * Kept out of the route file because Next.js allows only route exports there,
 * and out of eur-launch-run.ts because that module must load under plain
 * `node` with no Supabase client (scripts/stripe-eur/eur-launch-preflight.mjs).
 *
 * WHY pricing_switches AND NOT A NEW TABLE. The flag is a switch like the
 * others in that table, and the table is already service-role only (RLS on,
 * every grant revoked from anon and authenticated). The alert claims are rows
 * there too, keyed `eur_launch_alert:<Oslo day>:<reason>`: the primary key
 * makes the first insert of a day win, which is the whole dedupe, with no new
 * table, no new grants and no hand-written database types.
 */

import type { Json } from '@/types/database.types';
import type { createServiceRoleClient } from '@/lib/supabase/service';
import { alertKey, type LaunchAlert, type LaunchStore } from '@/lib/stripe/eur-launch-run';

type Db = ReturnType<typeof createServiceRoleClient>;

/** The launch's rows in public.pricing_switches (service role only). */
export function pricingSwitchStore(db: Db): LaunchStore {
  return {
    async readFlag(key) {
      const { data, error } = await db.from('pricing_switches').select('enabled').eq('key', key).maybeSingle();
      if (error) {
        console.error('[eur-launch] flag read failed', { key, error: error.message });
        return null;
      }
      return data?.enabled === true;
    },
    async writeFlag(key, enabled, note) {
      const { error } = await db
        .from('pricing_switches')
        .upsert({ key, enabled, note, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(`flag write failed: ${error.message}`);
    },
    async claimAlert(day, reason, note) {
      // The primary key on `key` makes this the dedupe: the first insert of
      // the day for a reason wins, every later one hits 23505 and sends
      // nothing. Any other error also sends nothing, since the alert itself
      // would go out through the same database.
      const { error } = await db
        .from('pricing_switches')
        .insert({ key: alertKey(day, reason), enabled: true, note: note.slice(0, 200) });
      if (!error) return true;
      if (error.code !== '23505') console.error('[eur-launch] alert claim failed', { error: error.message });
      return false;
    },
  };
}

export function systemEventNotify(db: Db) {
  return async (alert: LaunchAlert): Promise<void> => {
    const payload: Json = { kind: alert.kind, subject: alert.subject, lines: alert.lines };
    const { error } = await db.rpc('emit_system_event', { p_event_type: 'billing.eur_launch', p_payload: payload });
    if (error) console.error('[eur-launch] alert failed', { kind: alert.kind, error: error.message });
  };
}
