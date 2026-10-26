import { after } from 'next/server';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { clientOnboardingVariant, getOnboardingVariant } from '@/lib/onboarding/variant';
import { loadOnboardingStatus, type OnboardingStatus } from '@/lib/onboarding/status';
import { inferOnboardingClient } from '@/lib/onboarding/clients.mjs';
import { isOnboardingStep } from '@/lib/onboarding/flow';
import { verifyChatConnectLink } from '@/lib/onboarding/chat-connect-link';
import {
  CLIENT_INTENT_PARAM,
  CONNECT_INTENT_PARAM,
  connectIntentSlugShape,
  withClientIntent,
  withConnectIntent,
} from '@/lib/connect/intent-carry.mjs';
import { OnboardingApp } from '../../components/onboarding/OnboardingApp';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * /onboarding: the setup flow for workspaces in onb_flow = new (v1: internal
 * accounts only, src/lib/onboarding/variant.ts). Everyone else is sent to the
 * dashboard with their hints intact, so a stray link never strands anyone.
 *
 * Server work before the first byte of the page (loading.js has already
 * painted the shell): the session, the active workspace, and its arm. The
 * status read is NOT awaited: it is handed to the client as a promise and
 * streams into the step body (OnboardingApp's Suspense boundary).
 *
 * Query params: ?client= (chip start, see clients.mjs), ?provider= (a
 * /connect/<slug> hint for the inbox step), ?step= (jump to a step, for QA),
 * and a signed chat connect link (?from=chat&exp=&sig=, from the MCP server's
 * no-inbox answer): only the inbox step, then "Go back to <client> and ask
 * again" (src/lib/onboarding/chat-connect-link.ts).
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

  const statusPromise: Promise<OnboardingStatus | null> = loadOnboardingStatus(supabase, workspaceId).catch((error) => {
    console.error('[onboarding] initial status failed', error instanceof Error ? error.message : String(error));
    return null;
  });

  const requestedStep = one(params.step);
  const chatReturn = verifyChatConnectLink(params, workspaceId);
  return (
    <OnboardingApp
      variant={clientOnboardingVariant(variant)}
      initialClient={inferred.client}
      provider={provider}
      mcpUrl={`${process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com'}/api/mcp`}
      userEmail={user.email ?? ''}
      statusPromise={statusPromise}
      requestedStep={isOnboardingStep(requestedStep) ? requestedStep : null}
      chatReturn={chatReturn}
    />
  );
}
