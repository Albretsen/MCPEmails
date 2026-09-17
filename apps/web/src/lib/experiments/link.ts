/**
 * Joining the anonymous visitor to the account they created.
 *
 * This is the one row that turns "which homepage did they see" into "did they
 * sign up". It is written once, on the first authenticated render after a new
 * account is created, and the RPC's `on conflict do nothing` means an
 * anonymous id can never be re-pointed at a second account.
 *
 * No next imports here, so this file stays importable from a test. The
 * request-scoped wrapper lives in link-request.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { isValidSubjectId } from './bucketing.ts';

export interface LinkExperimentSubjectInput {
  subjectId: string | null;
  workspaceId: string | null;
  userId?: string | null;
}

/**
 * Record the join. Errors are logged and swallowed: this runs inside a page
 * render, and an analytics write must never be the reason a dashboard 500s.
 */
export async function linkExperimentSubject(
  client: SupabaseClient<Database>,
  { subjectId, workspaceId, userId }: LinkExperimentSubjectInput,
): Promise<void> {
  if (!isValidSubjectId(subjectId)) return;
  if (!workspaceId) return;

  try {
    const { error } = await client.rpc('experiment_link_subject', {
      p_subject_id: subjectId,
      p_workspace_id: workspaceId,
      // Verified against the live definition: the function is not STRICT and
      // `experiment_subjects.user_id` is nullable, so NULL is the intended
      // "anonymous" value here. The type generator cannot express a nullable
      // function argument, so it types every arg non-null.
      p_user_id: (userId ?? null) as unknown as string,
    });
    if (error) console.error('[experiments] subject link failed', { error: error.message });
  } catch (error) {
    console.error('[experiments] subject link threw', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
