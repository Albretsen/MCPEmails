// ---------------------------------------------------------------------------
// client-api's own database access, behind one interface.
//
// Everything here runs with the service-role client the MCP server module
// already holds (one client, one connection pool per isolate). The interface
// exists so the router, gate and allowance logic are testable with an
// in-memory store; `supabaseStore` is the production implementation.
//
// What is NOT here: mail. client-api stores no mail content and writes no
// `activity_log` rows (those feed the MCP rate limiters).
// ---------------------------------------------------------------------------

import type { AssistantAllowance, AssistantUsage, PlanSlug } from "./assistant-deps.ts";
import type { Membership, MembershipSource, WorkspaceRole } from "./auth.ts";
import { LOGIN_REFUSED_LIKE, loginRefusedMarker } from "./mail/health.ts";
import type { ApiKeyRow, InboxRow } from "./seam.ts";

/** `api_keys.kind` for the hidden per-workspace row. */
export const WEB_CLIENT_KEY_KIND = "web_client";
/** Reserved name. The dashboard never lists a row with a non-null `kind`. */
export const WEB_CLIENT_KEY_NAME = "__web_client__";
export const WEB_CLIENT_KEY_PREFIX = "mcpe_webclient";

/** Every scope the tool layer checks; viewers are narrowed in workspace-key.ts. */
export const WEB_CLIENT_KEY_SCOPES: readonly string[] = [
  "read:email",
  "search:email",
  "send:email",
  "manage:folders",
  "delete:email",
  "manage:drafts",
  "manage:contacts",
  "schedule:email",
];

export interface AllowanceRow {
  plan: string;
  cap: number | null;
  used: number;
  remaining: number | null;
  period_start: string;
  period_end: string;
  max_tokens_per_run: number;
}

export interface ReservationRow extends AllowanceRow {
  reservation_id: string | null;
  allowed: boolean;
}

export interface Store extends MembershipSource {
  userProfile(userId: string): Promise<{ display_name: string | null } | null>;
  /** The live hidden key row for this workspace, creating it if absent. */
  ensureWebClientKey(workspaceId: string): Promise<ApiKeyRow>;
  allowance(workspaceId: string): Promise<AllowanceRow | null>;
  reserveRun(workspaceId: string, userId: string): Promise<ReservationRow | null>;
  finalizeRun(reservationId: string, usage: AssistantUsage): Promise<void>;
  /**
   * Record on the inbox row that the mail server refused its login at `at`
   * (mail/health.ts explains the marker). `status` is not touched, and only an
   * 'active', undeleted row of this workspace is written.
   */
  markLoginRefused(inboxId: string, workspaceId: string, at: number): Promise<void>;
  /** Remove that marker, and only that marker, after a login that worked. */
  clearLoginRefused(inboxId: string, workspaceId: string): Promise<void>;
}

const PLAN_SLUGS: readonly string[] = ["free", "personal", "solo", "pro"];

/** `enterprise` (and anything unknown) reads as the top listed plan / free. */
export function planSlug(plan: string | null | undefined): PlanSlug {
  if (plan && PLAN_SLUGS.includes(plan)) return plan as PlanSlug;
  return plan === "enterprise" ? "pro" : "free";
}

export function toAssistantAllowance(row: AllowanceRow): AssistantAllowance {
  return {
    plan: planSlug(row.plan),
    used: row.used,
    cap: row.cap,
    remaining: row.remaining,
    period_start: new Date(row.period_start).toISOString(),
    resets_at: new Date(row.period_end).toISOString(),
    max_tokens_per_run: row.max_tokens_per_run,
  };
}

/** A key_hash no presented key can ever hash to: not hex, not 64 chars. */
export function unusableKeyHash(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `!web-client:${hex}`;
}

// The review-card build column is deliberately not selected: it tracks what an
// MCP client's tools/list was told, and this key never serves a tools/list.
const KEY_COLUMNS =
  "id, workspace_id, created_by, name, key_prefix, key_hash, scopes, inbox_ids, expires_at, last_used_at, deleted_at, created_at";

// deno-lint-ignore no-explicit-any
type Db = any;

function first<T>(data: T | T[] | null | undefined): T | null {
  if (data === null || data === undefined) return null;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

export interface SupabaseStoreOptions {
  /**
   * The `inboxes` projection the tool layer's `resolveInbox` selects. When
   * given, `memberships` loads each workspace's hidden key row and inbox rows
   * in the same request (PostgREST embeds), so a cold isolate needs ONE round
   * trip before its handler instead of three in a row. The column list must be
   * the tool layer's own: a narrower row in the inbox cache would reach an
   * executor without its credentials.
   */
  inboxColumns?: string;
}

interface EmbeddedWorkspace {
  display_name: string;
  plan: string;
  web_client_enabled: boolean | null;
  api_keys?: ApiKeyRow[] | null;
  inboxes?: InboxRow[] | null;
}

interface EmbeddedMemberRow {
  workspace_id: string;
  role: WorkspaceRole;
  joined_at: string;
  workspaces: EmbeddedWorkspace | EmbeddedWorkspace[] | null;
}

export function supabaseStore(db: Db, options: SupabaseStoreOptions = {}): Store {
  /** Memberships + hidden keys + inbox rows in one request, or null when the embed is refused. */
  const bootMemberships = async (userId: string, inboxColumns: string): Promise<Membership[] | null> => {
    const { data, error } = await db
      .from("workspace_members")
      .select(
        "workspace_id, role, joined_at, workspaces!inner(id, display_name, plan, web_client_enabled, deleted_at, " +
          `api_keys(${KEY_COLUMNS}), inboxes(${inboxColumns}))`,
      )
      .eq("user_id", userId)
      .is("workspaces.deleted_at", null)
      .eq("workspaces.api_keys.kind", WEB_CLIENT_KEY_KIND)
      .is("workspaces.api_keys.deleted_at", null)
      .is("workspaces.inboxes.deleted_at", null);
    // Any refusal (an ambiguous relationship after a schema change, a column
    // a migration has not landed) falls back to the plain query below.
    if (error || !Array.isArray(data)) return null;
    const out: Membership[] = [];
    for (const row of data as EmbeddedMemberRow[]) {
      const ws = first(row.workspaces);
      if (!ws) continue;
      const key = (ws.api_keys ?? []).find((k) => k.workspace_id === row.workspace_id && !k.deleted_at) ?? null;
      out.push({
        workspace_id: row.workspace_id,
        role: row.role,
        joined_at: row.joined_at,
        display_name: ws.display_name,
        plan: ws.plan,
        web_client_enabled: ws.web_client_enabled === true,
        web_client_key: key,
        inbox_rows: (ws.inboxes ?? []).filter((inbox) => inbox.workspace_id === row.workspace_id),
      });
    }
    return out;
  };

  const findKey = async (workspaceId: string): Promise<ApiKeyRow | null> => {
    const { data, error } = await db
      .from("api_keys")
      .select(KEY_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("kind", WEB_CLIENT_KEY_KIND)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`web_client_key_lookup_failed:${error.code ?? "error"}`);
    return (data as ApiKeyRow | null) ?? null;
  };

  return {
    async memberships(userId) {
      if (options.inboxColumns) {
        const boot = await bootMemberships(userId, options.inboxColumns).catch(() => null);
        if (boot) return boot;
      }
      const { data, error } = await db
        .from("workspace_members")
        .select("workspace_id, role, joined_at, workspaces!inner(id, display_name, plan, web_client_enabled, deleted_at)")
        .eq("user_id", userId)
        .is("workspaces.deleted_at", null);
      if (error) throw new Error(`memberships_failed:${error.code ?? "error"}`);
      const rows = (data ?? []) as Array<{
        workspace_id: string;
        role: WorkspaceRole;
        joined_at: string;
        workspaces: {
          display_name: string;
          plan: string;
          web_client_enabled: boolean;
        } | Array<{ display_name: string; plan: string; web_client_enabled: boolean }>;
      }>;
      const out: Membership[] = [];
      for (const row of rows) {
        const ws = first(row.workspaces);
        if (!ws) continue;
        out.push({
          workspace_id: row.workspace_id,
          role: row.role,
          joined_at: row.joined_at,
          display_name: ws.display_name,
          plan: ws.plan,
          web_client_enabled: ws.web_client_enabled === true,
        });
      }
      return out;
    },

    async userProfile(userId) {
      const { data, error } = await db.from("users").select("display_name").eq("id", userId).maybeSingle();
      if (error) return null;
      return data ? { display_name: (data as { display_name: string | null }).display_name ?? null } : null;
    },

    async ensureWebClientKey(workspaceId) {
      const existing = await findKey(workspaceId);
      if (existing) return existing;
      const { data, error } = await db
        .from("api_keys")
        .insert({
          workspace_id: workspaceId,
          // No human minted this key: member-removal sweeps filter on
          // created_by and must never match it.
          created_by: null,
          name: WEB_CLIENT_KEY_NAME,
          key_prefix: WEB_CLIENT_KEY_PREFIX,
          key_hash: unusableKeyHash(),
          scopes: [...WEB_CLIENT_KEY_SCOPES],
          inbox_ids: null,
          kind: WEB_CLIENT_KEY_KIND,
        })
        .select(KEY_COLUMNS)
        .maybeSingle();
      if (!error && data) return data as ApiKeyRow;
      // Lost a race with another isolate: the partial unique index
      // (one live web_client key per workspace) refused the second insert.
      const raced = await findKey(workspaceId);
      if (raced) return raced;
      throw new Error(`web_client_key_create_failed:${error?.code ?? "error"}`);
    },

    async allowance(workspaceId) {
      const { data, error } = await db.rpc("workspace_assistant_allowance", { p_workspace_id: workspaceId });
      if (error) throw new Error(`assistant_allowance_failed:${error.code ?? "error"}`);
      return first(data as AllowanceRow | AllowanceRow[] | null);
    },

    async reserveRun(workspaceId, userId) {
      const { data, error } = await db.rpc("reserve_assistant_run", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
      });
      if (error) throw new Error(`assistant_reserve_failed:${error.code ?? "error"}`);
      return first(data as ReservationRow | ReservationRow[] | null);
    },

    async finalizeRun(reservationId, usage) {
      const { error } = await db.rpc("finalize_assistant_run", {
        p_reservation_id: reservationId,
        p_input_tokens: Math.max(0, Math.round(usage.input_tokens)),
        p_output_tokens: Math.max(0, Math.round(usage.output_tokens)),
        p_cost_micro_usd: Math.max(0, Math.round(usage.cost_micro_usd)),
        p_model: usage.model.slice(0, 200),
      });
      if (error) throw new Error(`assistant_finalize_failed:${error.code ?? "error"}`);
    },

    async markLoginRefused(inboxId, workspaceId, at) {
      const { error } = await db
        .from("inboxes")
        .update({ last_error: loginRefusedMarker(at) })
        .eq("id", inboxId)
        .eq("workspace_id", workspaceId)
        .eq("status", "active")
        .is("deleted_at", null);
      if (error) throw new Error(`login_refused_mark_failed:${error.code ?? "error"}`);
    },

    async clearLoginRefused(inboxId, workspaceId) {
      const { error } = await db
        .from("inboxes")
        .update({ last_error: null })
        .eq("id", inboxId)
        .eq("workspace_id", workspaceId)
        // Never a reason someone else wrote: only this function's own marker.
        .like("last_error", LOGIN_REFUSED_LIKE);
      if (error) throw new Error(`login_refused_clear_failed:${error.code ?? "error"}`);
    },
  };
}
