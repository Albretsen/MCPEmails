import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database as GeneratedDatabase } from '@/types/database.types';

/**
 * A service-role client whose schema is the generated `Database` plus
 * `public.cancellation_feedback`, typed column for column.
 *
 * WHY THIS EXISTS. `src/types/database.types.ts` is generated from the linked
 * production project and is never hand-edited, and until
 * supabase/migrations/20261024220000_cancellation_feedback.sql is applied
 * there it has no such table. CI type-checks the app twice: against that
 * committed file, and against types generated from a freshly migrated database
 * (which DO have the table). `createServiceRoleClient().from(
 * 'cancellation_feedback')` fails the first check, and `as any` would switch
 * checking off. This schema keeps every generated table and replaces only this
 * one (`Omit` first, so it is the same type whichever generated file is in
 * place), so it compiles against both and stays fully checked.
 *
 * Keep the shape in step with the migration. Once the migration is applied and
 * `npm run gen:types` has been rerun, callers can move to
 * createServiceRoleClient() and this file can go.
 *
 * Same environment and options as createServiceRoleClient (./service.ts):
 * BYPASSES RLS, server-side only.
 */

export type CancellationFeedbackTable = {
  Row: {
    id: string;
    stripe_customer_id: string | null;
    user_id: string | null;
    subscription_id: string;
    period_end: string | null;
    reason: string;
    detail: string | null;
    source: string;
    created_at: string;
  };
  Insert: {
    id?: string;
    stripe_customer_id?: string | null;
    user_id?: string | null;
    subscription_id: string;
    period_end?: string | null;
    reason: string;
    detail?: string | null;
    source: string;
    created_at?: string;
  };
  Update: {
    id?: string;
    stripe_customer_id?: string | null;
    user_id?: string | null;
    subscription_id?: string;
    period_end?: string | null;
    reason?: string;
    detail?: string | null;
    source?: string;
    created_at?: string;
  };
  Relationships: [];
};

type GeneratedPublic = GeneratedDatabase['public'];

export type Database = Omit<GeneratedDatabase, 'public'> & {
  public: Omit<GeneratedPublic, 'Tables'> & {
    Tables: Omit<GeneratedPublic['Tables'], 'cancellation_feedback'> & {
      cancellation_feedback: CancellationFeedbackTable;
    };
  };
};

export function createFeedbackServiceClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for server-side admin operations.',
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
