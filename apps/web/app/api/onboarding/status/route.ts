import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { loadOnboardingStatus } from '@/lib/onboarding/status';

/**
 * GET /api/onboarding/status
 *
 * The /onboarding flow's one status read: inboxes, credential, MCP handshake,
 * first real call, last failed call. Shape and rules:
 * src/lib/onboarding/status.ts (OnboardingStatus). Polled by the wait step
 * (components/onboarding/useOnboardingStatus.js). RLS-scoped to the caller's
 * active workspace; never cached.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  try {
    const status = await loadOnboardingStatus(supabase, workspaceId);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[onboarding] status failed', error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'Could not load onboarding status.' }, { status: 500 });
  }
}
