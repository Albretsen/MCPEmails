import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';

/**
 * SSO sign-in entries in the SSO audit trail.
 *
 * WHERE. public.sso_audit_events (migration 20261019150000, PR #152), the same
 * append-only table that records SSO configuration changes. NOT
 * public.activity_log: that table records MCP tool calls and feeds the usage
 * counts, the growth board's active-workspace numbers and the dormant-grant
 * sweeps, so a sign-in row there would count as a tool call. Only the error
 * code is stored on a failure, never an email address or a provider message.
 *
 * Rows: action `user.sign_in` / `user.jit_join`, actor = the SSO user,
 * details = { outcome, error_code }. The SSO settings section lists
 * configuration changes only (lib/sso/admin.ts loadAuditEvents).
 */

export const SSO_AUDIT_EVENTS = {
  /** Someone signed in through the workspace's SSO connection. */
  signIn: 'user.sign_in',
  /** A new SSO user was added to the workspace on their first sign-in. */
  jitJoin: 'user.jit_join',
} as const;

export type SsoAuditEvent = (typeof SSO_AUDIT_EVENTS)[keyof typeof SSO_AUDIT_EVENTS];

export type SsoAuditEntry = {
  workspaceId: string;
  connectionId: string;
  userId: string;
  event: SsoAuditEvent;
  status: 'success' | 'error';
  errorCode?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type RecordSsoAudit = (entry: SsoAuditEntry) => Promise<void>;

/**
 * Writes with the service role (sso_audit_events has no user-writable
 * policy). Never throws: a missed audit row must not fail a sign-in, so
 * errors are logged instead.
 */
export function recordSsoAuditVia(service: SupabaseClient<Database>): RecordSsoAudit {
  // sso_audit_events is not in the generated Database types until its
  // migration is applied and `npm run gen:types` runs; a narrow view of
  // from() until then, bound back to the client.
  type Insert = { insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };
  const from = (service.from as unknown as (table: 'sso_audit_events') => Insert).bind(service);

  return async (entry) => {
    try {
      const { error } = await from('sso_audit_events').insert({
        workspace_id: entry.workspaceId,
        connection_id: entry.connectionId,
        actor_user_id: entry.userId,
        action: entry.event,
        details: { outcome: entry.status, error_code: entry.errorCode ?? null },
        ip_address: entry.ipAddress ?? null,
        user_agent: entry.userAgent?.slice(0, 512) ?? null,
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
