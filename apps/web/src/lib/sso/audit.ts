import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * SSO entries in the workspace audit log.
 *
 * The audit log is public.activity_log, the table the dashboard's Security
 * page reads (app/api/security/audit-log/route.ts). SSO events go in as rows
 * whose tool_name starts with `sso.`, with no api key and no inbox. Only the
 * error code is stored on a failure, never an email address or a provider
 * message: activity_log is value-free by rule (see its error_details comment).
 */

export const SSO_AUDIT_EVENTS = {
  /** Someone signed in through the workspace's SSO connection. */
  signIn: 'sso.sign_in',
  /** A new SSO user was added to the workspace on their first sign-in. */
  jitJoin: 'sso.jit_join',
} as const;

export type SsoAuditEvent = (typeof SSO_AUDIT_EVENTS)[keyof typeof SSO_AUDIT_EVENTS];

export type SsoAuditEntry = {
  workspaceId: string;
  event: SsoAuditEvent;
  status: 'success' | 'error';
  errorCode?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type RecordSsoAudit = (entry: SsoAuditEntry) => Promise<void>;

/**
 * Writes with the service role (activity_log has no user-writable policy).
 * Never throws: a missed audit row must not fail a sign-in, so errors are
 * logged instead.
 */
export function recordSsoAuditVia(service: SupabaseClient<Database>): RecordSsoAudit {
  return async (entry) => {
    try {
      const { error } = await service.from('activity_log').insert({
        workspace_id: entry.workspaceId,
        tool_name: entry.event,
        status: entry.status,
        error_code: entry.errorCode ?? null,
        ip_address: entry.ipAddress ?? null,
        user_agent: entry.userAgent ?? null,
      });
      if (error) console.error('[sso-audit] insert failed:', error.message);
    } catch (err) {
      console.error('[sso-audit] insert failed:', err);
    }
  };
}

/** The client address Vercel forwards, first hop only. */
export function clientIpFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || headers.get('x-real-ip')?.trim();
  // inet column: anything that does not look like an address is dropped
  // rather than failing the insert.
  return ip && /^[0-9a-f.:]+$/i.test(ip) ? ip : null;
}
