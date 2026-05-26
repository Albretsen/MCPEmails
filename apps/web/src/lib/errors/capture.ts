/**
 * Server-side error capture helper.
 *
 * Writes structured error records to the `app_errors` Supabase table.
 * The interface is designed to be Sentry-compatible: to swap the backend,
 * replace the internals of this function without touching any call sites.
 *
 * Usage:
 *   await captureError(err, { severity: 'high', route: '/api/foo', userId });
 *
 * To swap to Sentry:
 *   Replace the Supabase insert with:
 *     Sentry.captureException(err, { level: context.severity, extra: context });
 *
 * Review unresolved errors (Supabase SQL editor):
 *   SELECT id, created_at, severity, message, context
 *   FROM app_errors
 *   WHERE resolved_at IS NULL
 *   ORDER BY created_at DESC
 *   LIMIT 50;
 */

import { createServiceRoleClient } from '@/lib/supabase/service';
import type { Json } from '@/types/database.types';

type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface CaptureErrorContext {
  severity?: Severity;
  [key: string]: unknown;
}

export async function captureError(
  err: unknown,
  context: CaptureErrorContext = {},
): Promise<void> {
  const { severity = 'medium', ...rest } = context;

  const message =
    err instanceof Error ? err.message : String(err);
  const stack =
    err instanceof Error ? (err.stack ?? null) : null;

  try {
    const service = createServiceRoleClient();
    await service.from('app_errors').insert({
      severity,
      message,
      stack,
      context: rest as unknown as Json,
    });
  } catch (insertErr) {
    // Never let error tracking crash the caller. Log to stderr only.
    console.error('[captureError] Failed to record error:', insertErr);
    console.error('[captureError] Original error:', message);
  }
}
