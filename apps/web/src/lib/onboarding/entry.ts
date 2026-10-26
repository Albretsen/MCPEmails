/**
 * Getting a new workspace into the right onboarding, on both entry paths.
 * Server only.
 *
 *   web signup        /auth/callback (OAuth) and the first dashboard render
 *                     (password) call getOnboardingVariant; a `new` workspace
 *                     whose destination is the first-run dashboard is sent to
 *                     /onboarding instead (onboardingEntryPath).
 *   connector-first   app/authorize/page.js calls noteConnectorFirstWorkspace
 *                     after the consent screen renders: it assigns the arms
 *                     and stores the AI app the OAuth client is
 *                     (workspaces.onboarding_client), so the chip starts there.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database.types';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { chipClientFromUrl } from './clients.mjs';
import { ENROLL_WINDOW_MS, assignOnboardingAtSignup } from './variant.ts';

type Db = SupabaseClient<Database>;

/** Params the first-run dashboard URL carries that /onboarding also reads. */
const CARRIED_PARAMS = ['provider', 'client', 'signup_method'];

/**
 * '/onboarding?...' for a first-run dashboard destination ('/dashboard?firstrun=1...'),
 * keeping the provider, client and signup-method hints; null for any other
 * destination (an invite, a checkout redirect, a plain /dashboard), which must
 * be honoured as it is.
 */
export function onboardingEntryPath(destination: string | null | undefined): string | null {
  if (typeof destination !== 'string' || !destination.startsWith('/dashboard')) return null;
  let url: URL;
  try {
    url = new URL(destination, 'https://x.invalid');
  } catch {
    return null;
  }
  if (url.pathname !== '/dashboard' && url.pathname !== '/dashboard/') return null;
  if (url.searchParams.get('firstrun') !== '1') return null;
  const out = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const value = url.searchParams.get(key);
    if (value) out.set(key, value);
  }
  const qs = out.toString();
  return qs ? `/onboarding?${qs}` : '/onboarding';
}

/**
 * Connector-first: a user who reached the consent screen of an OAuth client.
 * For the OWNER of a workspace created in the last 24 hours: assign the
 * onboarding arms (idempotent), and store which AI app the client is when the
 * workspace has none yet. Never throws; runs after the response.
 */
export async function noteConnectorFirstWorkspace(input: {
  workspaceId: string;
  userId: string;
  userEmail: string | null;
  redirectUri: string | null;
  db?: Db;
  now?: number;
}): Promise<void> {
  try {
    const db = input.db ?? createServiceRoleClient();
    const { data: ws } = await db
      .from('workspaces')
      .select('owner_id, created_at, onboarding_client')
      .eq('id', input.workspaceId)
      .maybeSingle();
    if (!ws || ws.owner_id !== input.userId) return;
    const age = (input.now ?? Date.now()) - Date.parse(ws.created_at);
    if (!Number.isFinite(age) || age < 0 || age >= ENROLL_WINDOW_MS) return;

    await assignOnboardingAtSignup(input.workspaceId, {
      ownerEmail: input.userEmail,
      workspaceCreatedAt: ws.created_at,
      db,
    });

    const client = chipClientFromUrl(input.redirectUri);
    if (client && !ws.onboarding_client) {
      await db.from('workspaces')
        .update({ onboarding_client: client })
        .eq('id', input.workspaceId)
        .is('onboarding_client', null);
    }
  } catch (error) {
    console.error('[onboarding] connector-first note failed', error instanceof Error ? error.message : String(error));
  }
}
