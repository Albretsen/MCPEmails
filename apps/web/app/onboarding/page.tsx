import { after } from 'next/server';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { getOnboardingVariant } from '@/lib/onboarding/variant';
import { inferOnboardingClient } from '@/lib/onboarding/clients.mjs';
import {
  CLIENT_INTENT_PARAM,
  CONNECT_INTENT_PARAM,
  connectIntentSlugShape,
  withClientIntent,
  withConnectIntent,
} from '@/lib/connect/intent-carry.mjs';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** Params that only mean something to the dashboard's first-run entry. */
const DROPPED_PARAMS = new Set(['setup', 'firstrun']);

/**
 * /onboarding: the entry to the setup flow for workspaces in onb_flow = new
 * (v1: internal accounts only, src/lib/onboarding/variant.ts). The flow itself
 * is a modal over the dashboard (components/onboarding/SetupModal.jsx), so this
 * route only checks the arm, keeps a ?client= choice, and redirects to
 * /dashboard?setup=1 with every other param intact. Everyone else goes to the
 * dashboard with their hints, so a stray link never strands anyone.
 *
 * Params the modal reads: ?client= (chip start, see clients.mjs), ?provider= (a
 * /connect/<slug> hint for the inbox step), ?step= (jump to a step, for QA), a
 * signed chat connect link (?from=chat&exp=&sig=, only the inbox step, then
 * "Go back to <client> and ask again"), and the Microsoft sign-in's return
 * (?connected=outlook, ?outlook_error=).
 */
export default async function OnboardingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const clientParam = one(params[CLIENT_INTENT_PARAM]);
  const provider = connectIntentSlugShape(one(params[CONNECT_INTENT_PARAM]));

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent('/onboarding')}`);

  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  const toDashboard = withClientIntent(withConnectIntent('/dashboard', provider), clientParam);
  if (!workspaceId) redirect(toDashboard);

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('owner_id, created_at, onboarding_client, acquisition_source, acquisition_referrer')
    .eq('id', workspaceId)
    .maybeSingle();
  if (!workspace) redirect(toDashboard);

  const variant = await getOnboardingVariant(workspaceId, {
    workspaceCreatedAt: workspace.created_at,
    ownerEmail: workspace.owner_id === user.id ? (user.email ?? null) : null,
  });
  if (variant.flow !== 'new') redirect(toDashboard);

  const inferred = inferOnboardingClient({
    param: clientParam,
    stored: workspace.onboarding_client,
    acquisitionSource: workspace.acquisition_source,
    acquisitionReferrer: workspace.acquisition_referrer,
  });
  // A ?client= hint is an explicit choice made before signup: keep it on the
  // workspace so every later surface (emails, the dashboard guide) knows it.
  // Inferred defaults are not written.
  if (inferred.source === 'param' && workspace.onboarding_client !== inferred.client) {
    const id = workspaceId;
    after(async () => {
      await createServiceRoleClient().from('workspaces').update({ onboarding_client: inferred.client }).eq('id', id);
    });
  }

  const query = new URLSearchParams({ setup: '1' });
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && !DROPPED_PARAMS.has(key)) query.set(key, value);
  }
  redirect(`/dashboard?${query.toString()}`);
}
