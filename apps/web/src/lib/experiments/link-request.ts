/**
 * The request-scoped half of the subject join. Server only (next/headers).
 */
import { cookies, headers } from 'next/headers';
import { isValidSubjectId } from './bucketing.ts';
import { SUBJECT_COOKIE, SUBJECT_HEADER } from './constants.ts';
import { linkExperimentSubject } from './link.ts';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { isNewAccountSignup } from '@/lib/acquisition-context.mjs';

export interface LinkForRequestInput {
  workspaceId: string | null;
  userId?: string | null;
  /** auth.users.created_at for the signed-in user. */
  userCreatedAt?: string | number | null;
}

/**
 * Called from the dashboard's first authenticated render.
 *
 * The isNewAccountSignup gate is what keeps this from being wrong: every
 * returning customer also loads the dashboard, carrying a subject cookie from
 * whatever marketing page they last wandered past, and linking those would
 * credit old accounts to experiments that started years later. Only an account
 * created inside the new-signup window is joined.
 */
export async function linkExperimentSubjectForRequest({
  workspaceId,
  userId,
  userCreatedAt,
}: LinkForRequestInput): Promise<void> {
  try {
    if (!workspaceId) return;
    if (!isNewAccountSignup(userCreatedAt)) return;

    const fromHeader = (await headers()).get(SUBJECT_HEADER);
    const subjectId = isValidSubjectId(fromHeader)
      ? fromHeader
      : (await cookies()).get(SUBJECT_COOKIE)?.value ?? null;
    if (!isValidSubjectId(subjectId)) return;

    await linkExperimentSubject(createServiceRoleClient(), { subjectId, workspaceId, userId });
  } catch (error) {
    console.error('[experiments] subject link for request threw', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
