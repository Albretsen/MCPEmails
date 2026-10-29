import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database.types';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { resolveActiveWorkspaceId } from '@/lib/workspace/active';
import { canManageWorkspace, fetchWorkspaceRole, insufficientRoleBody, type WorkspaceRole } from '@/lib/workspace/roles';
import { resolveEffectiveWorkspacePlan } from '@/lib/plans/effective-plan';
import { ssoVerificationRecord } from '@/lib/sso/domains';
import { SSO_DEFAULT_ROLES, type SsoConnection, type SsoDefaultRole, type SsoDomain } from '@/lib/sso/types';

/**
 * Shared plumbing for the SSO admin routes (app/api/sso/**): who may call
 * them, the database access they need, and the audit trail.
 *
 * WHO. Owner or admin of the caller's ACTIVE workspace (the cookie-selected
 * one, re-checked against membership by resolveActiveWorkspaceId), and only
 * when that workspace is on the enterprise plan. Role and plan are read with
 * the request-scoped USER client: under the service role both lookups would
 * answer for any workspace and stop being a check. Only after both pass does a
 * route get the service-role client, and every query it then makes is pinned
 * to that workspace id.
 *
 * ENTITLEMENT. `enterprise` is an existing plan slug (workspaces_plan_check),
 * but nothing sells it yet: the owner sets it by hand. When the enterprise
 * tier gets its real slug or a feature flag, change isSsoEntitledPlan().
 */

export const SSO_ENTITLED_PLANS = ['enterprise'] as const;

export function isSsoEntitledPlan(plan: string | null | undefined): boolean {
  return typeof plan === 'string' && (SSO_ENTITLED_PLANS as readonly string[]).includes(plan);
}

export function isSsoDefaultRole(value: unknown): value is SsoDefaultRole {
  return typeof value === 'string' && (SSO_DEFAULT_ROLES as readonly string[]).includes(value);
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type SsoErrorCode =
  | 'unauthorized'
  | 'no_workspace'
  | 'insufficient_role'
  | 'plan_required'
  | 'plan_unresolved'
  | 'invalid_request'
  | 'invalid_metadata_url'
  | 'metadata_rejected'
  | 'management_not_configured'
  | 'management_unavailable'
  | 'no_connection'
  | 'no_provider'
  | 'invalid_domain'
  | 'consumer_domain'
  | 'domain_exists'
  | 'domain_limit'
  | 'domain_taken'
  | 'domain_not_found'
  | 'dns_record_missing'
  | 'dns_lookup_failed'
  | 'rate_limited'
  | 'enforce_needs_active'
  | 'enforce_needs_verified_domain'
  | 'enforce_needs_test_sign_in'
  | 'server_error';

export function ssoError(status: number, code: SsoErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: message, error_code: code }, { status });
}

// ── Authorization ────────────────────────────────────────────────────────────

export interface SsoAdminContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  /** Service-role access. Every query must filter on workspaceId. */
  db: SupabaseClient<Database>;
}

export type SsoAdminAuth = { ok: true; ctx: SsoAdminContext } | { ok: false; response: NextResponse };

export async function authorizeSsoAdmin(): Promise<SsoAdminAuth> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: ssoError(401, 'unauthorized', 'Unauthorized.') };
  }

  const workspaceId = await resolveActiveWorkspaceId(supabase, user.id);
  if (!workspaceId) {
    return { ok: false, response: ssoError(403, 'no_workspace', 'Workspace not found.') };
  }

  const role = await fetchWorkspaceRole(supabase, workspaceId, user.id);
  if (!role || !canManageWorkspace(role)) {
    return {
      ok: false,
      response: NextResponse.json(
        insufficientRoleBody('Only a workspace owner or admin can manage single sign-on.'),
        { status: 403 },
      ),
    };
  }

  const plan = await resolveEffectiveWorkspacePlan(supabase, workspaceId);
  if (!plan.resolved) {
    return { ok: false, response: ssoError(503, 'plan_unresolved', 'Could not read the workspace plan. Try again.') };
  }
  if (!isSsoEntitledPlan(plan.plan)) {
    return { ok: false, response: ssoError(403, 'plan_required', 'Single sign-on is part of the Enterprise plan.') };
  }

  return { ok: true, ctx: { userId: user.id, workspaceId, role, db: createServiceRoleClient() } };
}

/** Parses a JSON object body, or null. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const CONNECTION_COLUMNS =
  'id, workspace_id, supabase_sso_provider_id, display_name, status, enforced, default_role, created_by, created_at, updated_at';
export const DOMAIN_COLUMNS =
  'id, connection_id, workspace_id, domain, verification_token, verified_at, created_at, updated_at';

/** The workspace's connection (the oldest, if a race ever made two). */
export async function loadConnection(ctx: SsoAdminContext): Promise<SsoConnection | null> {
  const { data, error } = await ctx.db
    .from('sso_connections')
    .select(CONNECTION_COLUMNS)
    .eq('workspace_id', ctx.workspaceId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`load sso connection: ${error.message}`);
  return (data as SsoConnection | null) ?? null;
}

export async function loadDomains(ctx: SsoAdminContext, connectionId: string): Promise<SsoDomain[]> {
  const { data, error } = await ctx.db
    .from('sso_domains')
    .select(DOMAIN_COLUMNS)
    .eq('workspace_id', ctx.workspaceId)
    .eq('connection_id', connectionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`load sso domains: ${error.message}`);
  return Array.isArray(data) ? (data as SsoDomain[]) : [];
}

/** A domain of this workspace by id, or null. Never finds another workspace's row. */
export async function loadDomain(ctx: SsoAdminContext, domainId: string): Promise<SsoDomain | null> {
  if (!/^[0-9a-f-]{36}$/i.test(domainId)) return null;
  const { data, error } = await ctx.db
    .from('sso_domains')
    .select(DOMAIN_COLUMNS)
    .eq('id', domainId)
    .eq('workspace_id', ctx.workspaceId)
    .maybeSingle();
  if (error) throw new Error(`load sso domain: ${error.message}`);
  return (data as SsoDomain | null) ?? null;
}

export async function adminTestSignInSeen(ctx: SsoAdminContext, connection: SsoConnection): Promise<boolean> {
  if (!connection.supabase_sso_provider_id) return false;
  const { data, error } = await ctx.db.rpc('sso_admin_test_sign_in_seen', { p_connection_id: connection.id });
  if (error) throw new Error(`sso_admin_test_sign_in_seen: ${error.message}`);
  return data === true;
}

export interface SsoAuditEventView {
  id: string;
  action: SsoAuditAction;
  details: Record<string, unknown>;
  actorEmail: string | null;
  createdAt: string;
}

/**
 * The settings section lists configuration changes only. The same table also
 * holds a row per SAML sign-in (`user.*`, written by /auth/callback), which
 * would otherwise push every change out of the newest-N window.
 */
export async function loadAuditEvents(ctx: SsoAdminContext, limit = 20): Promise<SsoAuditEventView[]> {
  const { data, error } = await ctx.db
    .from('sso_audit_events')
    .select('id, action, details, actor_user_id, created_at')
    .eq('workspace_id', ctx.workspaceId)
    .in('action', SSO_CONFIG_AUDIT_ACTIONS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`load sso audit events: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as Array<{
    id: string;
    action: SsoAuditAction;
    details: Record<string, unknown> | null;
    actor_user_id: string | null;
    created_at: string;
  }>;

  const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter((id): id is string => !!id))];
  const emails = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: users } = await ctx.db.from('users').select('id, email').in('id', actorIds);
    for (const u of (Array.isArray(users) ? users : []) as Array<{ id: string; email: string }>) {
      emails.set(u.id, u.email);
    }
  }
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    details: r.details ?? {},
    actorEmail: r.actor_user_id ? (emails.get(r.actor_user_id) ?? null) : null,
    createdAt: r.created_at,
  }));
}

// ── Audit ────────────────────────────────────────────────────────────────────

/** Configuration changes an admin makes. Sign-in rows live in lib/sso/audit.ts. */
export const SSO_CONFIG_AUDIT_ACTIONS = [
  'connection.created',
  'connection.metadata_updated',
  'connection.default_role_changed',
  'connection.enforced',
  'connection.enforcement_removed',
  'connection.disabled',
  'connection.enabled',
  'domain.added',
  'domain.removed',
  'domain.verified',
] as const;

export type SsoAuditAction = (typeof SSO_CONFIG_AUDIT_ACTIONS)[number];

/**
 * Appends one audit row. Runs after the change it records has been written;
 * a failure here is logged loudly but does not undo or fail that change, so
 * an audit outage cannot leave the settings half-applied.
 */
export async function recordSsoAudit(
  ctx: SsoAdminContext,
  action: SsoAuditAction,
  connectionId: string | null,
  details: Record<string, string | boolean | null> = {},
): Promise<void> {
  try {
    const { error } = await ctx.db.from('sso_audit_events').insert({
      workspace_id: ctx.workspaceId,
      connection_id: connectionId,
      actor_user_id: ctx.userId,
      action,
      details,
    });
    if (error) console.error('[sso] audit insert failed', action, error.message);
  } catch (err) {
    console.error('[sso] audit insert threw', action, err);
  }
}

// ── Views sent to the browser ────────────────────────────────────────────────

export interface SsoConnectionView {
  id: string;
  status: SsoConnection['status'];
  enforced: boolean;
  defaultRole: SsoDefaultRole;
  /** A Supabase provider exists (metadata accepted). The id itself stays server-side. */
  hasProvider: boolean;
  updatedAt: string;
}

export function connectionView(c: SsoConnection): SsoConnectionView {
  return {
    id: c.id,
    status: c.status,
    enforced: c.enforced,
    defaultRole: c.default_role,
    hasProvider: !!c.supabase_sso_provider_id,
    updatedAt: c.updated_at,
  };
}

export interface SsoDomainView {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  /** The TXT record value to publish. Public by design: it goes into DNS. */
  txtRecord: string;
}

export function domainView(d: SsoDomain): SsoDomainView {
  return {
    id: d.id,
    domain: d.domain,
    verified: d.verified_at !== null,
    verifiedAt: d.verified_at,
    txtRecord: ssoVerificationRecord(d.verification_token),
  };
}

/** Name a new connection gets. Not shown as editable in the UI. */
export const DEFAULT_CONNECTION_NAME = 'Microsoft Entra ID';

/**
 * Creates the workspace's draft connection, for when the admin starts with a
 * domain before pasting metadata. Audited.
 */
export async function createDraftConnection(ctx: SsoAdminContext): Promise<SsoConnection> {
  const { data, error } = await ctx.db
    .from('sso_connections')
    .insert({
      workspace_id: ctx.workspaceId,
      display_name: DEFAULT_CONNECTION_NAME,
      default_role: 'member',
      created_by: ctx.userId,
    })
    .select(CONNECTION_COLUMNS)
    .single();
  if (error || !data) throw new Error(`create sso connection: ${error?.message ?? 'no row'}`);
  const connection = data as SsoConnection;
  await recordSsoAudit(ctx, 'connection.created', connection.id, {});
  return connection;
}
