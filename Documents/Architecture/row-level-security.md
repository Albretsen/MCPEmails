# Row-Level Security (RLS) Architecture

## Purpose

Row-Level Security is the database-level enforcement mechanism that ensures every tenant in MCPEmails can only read and write their own data. Even if a bug in application code constructs a query that omits a workspace filter, the database itself silently limits the result set to rows the current session's JWT is authorized to see. This makes RLS the last—and most reliable—line of defence in a multi-tenant SaaS system.

This document defines which RLS policies are applied to each table, how the current user's identity and workspace membership are resolved from the JWT, the role model used by Supabase, and the security and performance considerations governing each policy.

---

## Role Model

Supabase exposes three PostgreSQL roles that application code must understand:

| Role | Description | When used |
|---|---|---|
| `anon` | Unauthenticated requests | Public sign-in pages; any request without a valid JWT |
| `authenticated` | Requests carrying a valid Supabase JWT | All Next.js server-side queries and MCP Edge Function requests made by users |
| `service_role` | Bypasses RLS entirely | Supabase internal operations, scheduled Edge Functions performing administrative work, database migrations |

**Critical rule:** The `service_role` key must never appear in client-facing code, browser environments, or environment variables accessible to Next.js Server Components that serve user requests. It is used exclusively inside Edge Functions that run in Supabase's trusted execution environment and during database migrations applied by CI/CD.

---

## Identity Resolution

Every query executed with the `authenticated` role carries a JWT issued by Supabase Auth. Three claims are relevant to RLS policies:

- **`auth.uid()`** — resolves to the `sub` claim; equals `public.users.id`.
- **`auth.role()`** — resolves to `'authenticated'` or `'anon'`.
- **`auth.jwt()`** — the full decoded JWT payload; used to extract custom claims when needed.

Workspace membership is not embedded in the JWT (embedding it would require token rotation on every membership change). Instead, policies use a helper function that joins `workspace_members` at query time:

```sql
-- Helper: returns the set of workspace IDs the current user is a member of.
-- Defined once; referenced in all workspace-scoped policies.
CREATE OR REPLACE FUNCTION public.my_workspace_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id
  FROM   public.workspace_members
  WHERE  user_id = auth.uid();
$$;
```

`SECURITY DEFINER` ensures the function executes with the permissions of its creator (a superuser role), so it can read `workspace_members` even if the calling role would otherwise be restricted. `STABLE` tells the query planner the function returns the same result for the same inputs within a single query, enabling memoisation across multiple policy checks in the same statement.

---

## Policy Design Principles

**Deny by default.** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` without any permissive policy results in zero rows returned for all roles. All tables have RLS enabled; access is granted only by explicit policies.

**Least privilege per operation.** Separate policies are defined for `SELECT`, `INSERT`, `UPDATE`, and `DELETE` rather than using a single `ALL` policy. This allows append-only semantics (e.g., audit tables that permit `INSERT` but deny `UPDATE`/`DELETE`) and fine-grained write control.

**Filter by `workspace_id` at the outermost scope.** Every tenant-scoped table has a `workspace_id` column. Policies always check `workspace_id = ANY(public.my_workspace_ids())` so the database can use an index on `workspace_id` before evaluating more expensive conditions.

**Policies compose with `OR` (permissive policies).** Supabase/PostgreSQL uses permissive policies by default: a row is visible if *any* permissive policy grants access. All policies in this system are permissive; there are no restrictive policies. This keeps the policy surface predictable.

**Service-role bypass is implicit.** `service_role` bypasses RLS at the PostgreSQL level. No policy code needs to special-case it; the bypass is enforced by the connection's role assignment.

---

## Per-Table Policies

### `public.users`

A user can see and modify only their own row. No workspace check is needed here because `users` is not tenant-scoped.

```sql
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- SELECT: a user can read their own profile.
CREATE POLICY "users_select_own"
  ON public.users FOR SELECT
  TO authenticated
  USING (id = auth.uid());

-- UPDATE: a user can update their own profile.
CREATE POLICY "users_update_own"
  ON public.users FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- INSERT: handled exclusively by the auth trigger (service_role);
-- application code never inserts directly.
-- No INSERT policy for 'authenticated' — the trigger runs as service_role.

-- DELETE: not permitted via application code; account deletion flows through
-- auth.users deletion, which cascades via the foreign key.
```

**Rationale:** Users editing their display name or avatar URL should only affect their own row. The `WITH CHECK` clause on `UPDATE` prevents a row being re-keyed to a different `id` (a defence-in-depth measure since the primary key is immutable anyway).

---

### `public.workspaces`

A workspace is visible to any member of that workspace. Only the owner may update workspace settings; deletion is blocked at the application layer (ownership must be transferred first) and is not granted to the `authenticated` role via RLS.

```sql
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

-- SELECT: visible to all members of the workspace.
CREATE POLICY "workspaces_select_members"
  ON public.workspaces FOR SELECT
  TO authenticated
  USING (id = ANY(public.my_workspace_ids()));

-- INSERT: a user may create a new workspace.
-- The trigger that creates the workspace_members row runs as service_role.
CREATE POLICY "workspaces_insert_authenticated"
  ON public.workspaces FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- UPDATE: only the workspace owner may change workspace settings.
CREATE POLICY "workspaces_update_owner"
  ON public.workspaces FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- DELETE: denied for authenticated role; handled via service_role after
-- ownership verification in application code.
```

**Note on workspace creation flow:** When a user creates a workspace, the application inserts into `workspaces` (permitted by the policy above) and then uses a service-role call (inside a Supabase transaction) to insert the corresponding `workspace_members` row. Alternatively, a `AFTER INSERT` trigger on `workspaces` running as `SECURITY DEFINER` can create the membership row automatically, keeping the flow atomic.

---

### `public.workspace_members`

Members can see who else is in their workspace. Only the workspace owner (via application logic enforced by service_role calls) may add or remove members; direct manipulation by the `authenticated` role is restricted.

```sql
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

-- SELECT: members can see the full membership list for their workspace.
CREATE POLICY "workspace_members_select"
  ON public.workspace_members FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- INSERT / UPDATE / DELETE: denied for authenticated role.
-- All membership changes go through service_role Edge Functions that
-- verify ownership before executing.
```

**Why deny writes?** Allowing the `authenticated` role to insert into `workspace_members` would create a privilege escalation risk: a user could add themselves to any workspace if there were a bug in the `WITH CHECK` expression. Delegating all writes to a `SECURITY DEFINER` Edge Function that validates ownership in application code is safer and easier to audit.

---

### `public.inboxes`

Inboxes are scoped to a workspace. Members may read inbox metadata; only the owner (or a member with appropriate role in a future multi-member model) may write. Soft-deleted rows (`deleted_at IS NOT NULL`) are excluded from all `authenticated` queries; only `service_role` can see them (for archival and restoration).

```sql
ALTER TABLE public.inboxes ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members see active (non-deleted) inboxes.
CREATE POLICY "inboxes_select_members"
  ON public.inboxes FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  );

-- INSERT: workspace members may connect a new inbox.
CREATE POLICY "inboxes_insert_members"
  ON public.inboxes FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
  );

-- UPDATE: workspace members may update inbox settings (display name, status).
-- The policy does not restrict which columns may change; column-level grants
-- are not used (too granular for this system). Application code is responsible
-- for not allowing untrusted updates to encrypted credential columns.
CREATE POLICY "inboxes_update_members"
  ON public.inboxes FOR UPDATE
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
  );

-- DELETE: hard delete is not permitted; soft delete via UPDATE (sets deleted_at).
-- The application issues UPDATE ... SET deleted_at = now() rather than DELETE.
```

**Credential column protection.** RLS cannot restrict access at the column level (PostgreSQL column-level privileges are a separate mechanism and are not used here). Instead, application code enforces that the `oauth_access_token`, `oauth_refresh_token`, and `imap_password` columns are only fetched by Edge Functions that genuinely need them. The Supabase dashboard and any diagnostic queries must use named columns, never `SELECT *`.

---

### `public.api_keys`

API key rows are scoped to a workspace. The `key_hash` column is readable (it's a hash, not a secret), but the application's list UI displays only `key_prefix` and metadata. Soft-deleted (revoked) keys are hidden from `authenticated` queries.

```sql
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members see active (non-revoked) keys.
CREATE POLICY "api_keys_select_members"
  ON public.api_keys FOR SELECT
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  );

-- INSERT: workspace members may create a new API key.
CREATE POLICY "api_keys_insert_members"
  ON public.api_keys FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
    AND created_by = auth.uid()
  );

-- UPDATE: workspace members may rename or update scope of a key.
CREATE POLICY "api_keys_update_members"
  ON public.api_keys FOR UPDATE
  TO authenticated
  USING (
    workspace_id = ANY(public.my_workspace_ids())
    AND deleted_at IS NULL
  )
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
  );

-- DELETE: not permitted; revocation is a soft delete via UPDATE (sets deleted_at).
```

**MCP authentication exception.** When the MCP Edge Function authenticates an incoming bearer token, it must look up `api_keys` by `key_hash` *without* a workspace filter (because the workspace is not known yet — it's derived from the key). This lookup uses the `service_role` key inside the Edge Function. Once the workspace is resolved, all subsequent queries in that request use workspace-filtered queries via the normal authenticated flow.

---

### `public.oauth_states`

OAuth state nonces are short-lived and user-specific. Only the initiating user should be able to read or delete their own state rows. No update is permitted (states are consumed and hard-deleted).

```sql
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- SELECT: a user sees only their own unexpired state rows.
CREATE POLICY "oauth_states_select_own"
  ON public.oauth_states FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND expires_at > now()
  );

-- INSERT: a user may create a state nonce for their own workspace.
CREATE POLICY "oauth_states_insert_own"
  ON public.oauth_states FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id = ANY(public.my_workspace_ids())
    AND user_id = auth.uid()
  );

-- DELETE: a user may delete (consume) their own state rows.
-- The OAuth callback handler deletes the row after validating the state.
CREATE POLICY "oauth_states_delete_own"
  ON public.oauth_states FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- UPDATE: not permitted.
```

**Note:** The OAuth callback is handled by a Next.js Route Handler. It creates a server-side Supabase client using the session cookie, which resolves to the `authenticated` role. The DELETE policy above permits the callback to consume the state row without requiring `service_role`.

---

### `public.activity_log`

The activity log is append-only. Workspace members may read their own workspace's log entries; no role (except `service_role`) may update or delete rows.

```sql
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

-- SELECT: workspace members may read their workspace's activity.
CREATE POLICY "activity_log_select_members"
  ON public.activity_log FOR SELECT
  TO authenticated
  USING (workspace_id = ANY(public.my_workspace_ids()));

-- INSERT: the MCP Edge Function writes log entries using service_role.
-- No INSERT policy is needed for authenticated; the Edge Function bypasses RLS.
-- However, if a future implementation writes log entries from a client-authenticated
-- context, the following policy can be enabled:
-- CREATE POLICY "activity_log_insert_service"
--   ON public.activity_log FOR INSERT
--   TO authenticated
--   WITH CHECK (workspace_id = ANY(public.my_workspace_ids()));

-- UPDATE and DELETE: explicitly denied for all non-service-role sessions.
-- No policies are created for these operations; the default-deny behaviour applies.
```

**Immutability guarantee.** Because no `UPDATE` or `DELETE` policy exists for `authenticated`, application bugs cannot tamper with audit entries. The only path to mutating log rows is via `service_role`, which is restricted to trusted server-side Edge Functions and administrative tooling.

---

### `public.auth_logs`

Security events follow the same append-only pattern as the activity log. No `authenticated` role INSERT policy is needed because all writes come from Supabase Auth hooks and Edge Functions running as `service_role`.

```sql
ALTER TABLE public.auth_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: users may read their own auth events.
CREATE POLICY "auth_logs_select_own"
  ON public.auth_logs FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR workspace_id = ANY(public.my_workspace_ids())
  );

-- INSERT / UPDATE / DELETE: no policies for authenticated;
-- all writes come from service_role Auth hooks and Edge Functions.
```

**Cross-workspace visibility.** The `SELECT` policy uses `OR` to allow a user to see events either tied to their user identity or to any workspace they belong to. This supports both a personal security log ("your logins") and a workspace security dashboard ("API key created/revoked events").

---

## Policy Testing

Every RLS policy must be validated in the Supabase local development environment using explicit role switching:

```sql
-- Test as an authenticated user (substitute a real user UUID):
SET LOCAL role TO authenticated;
SET LOCAL request.jwt.claims TO '{"sub": "<user-uuid>", "role": "authenticated"}';

-- Should return only this user's workspaces:
SELECT * FROM public.workspaces;

-- Should return nothing for a workspace the user doesn't belong to:
SELECT * FROM public.inboxes WHERE workspace_id = '<other-workspace-uuid>';

-- Attempt a disallowed delete (should affect 0 rows, not error):
DELETE FROM public.activity_log WHERE workspace_id = '<user-workspace-uuid>';
```

The test suite in `supabase/tests/rls/` contains a fixture that creates two isolated workspaces (Workspace A and Workspace B with separate user accounts) and asserts cross-tenant isolation for every table, every operation, and both the `authenticated` and `anon` roles.

---

## Security Considerations

**The `my_workspace_ids()` helper is `SECURITY DEFINER`.** This means it executes as its creator. If the creator is the Supabase `postgres` role, the function inherits full database access within its body. The body is intentionally minimal (a single parameterised query) and has `search_path` pinned to `public` to prevent search-path injection attacks. It must never be altered to accept external input.

**JWT sub claim spoofing.** Supabase validates JWT signatures using the project's secret key before setting `auth.uid()`. Application code never needs to re-validate JWTs; the database is the trust boundary.

**`anon` role access.** No table grants `SELECT` to the `anon` role except through explicitly constructed policies. All tables default to deny for `anon`. This means unauthenticated API requests return empty result sets, not errors, which avoids leaking table existence through error messages. Application code should still return appropriate HTTP 401 responses before hitting the database.

**Soft delete visibility.** Policies that filter `deleted_at IS NULL` ensure that revoked API keys and disconnected inboxes are invisible to the `authenticated` role. Service-role code that needs to restore or audit deleted rows must explicitly bypass RLS (by using the service-role client) or query via a `SECURITY DEFINER` function.

**Privilege escalation via `workspace_id` manipulation.** An `INSERT` or `UPDATE` policy's `WITH CHECK` clause must always re-derive workspace membership from `my_workspace_ids()`. It is insufficient to trust a `workspace_id` value supplied by the client; the `WITH CHECK` expression is the guard that enforces membership.

**Policy exhaustiveness.** PostgreSQL silently returns zero rows when no policy matches; it does not return an error. This means a missing policy is equivalent to a deny, which is the desired default. However, missing intended policies (e.g., a policy that should allow `INSERT` but doesn't exist) produce silent failures that look like permission denials. All policies are documented here and should be checked against the migration files in `supabase/migrations/`.

---

## Performance Considerations

**Index usage.** RLS policies are evaluated as additional `WHERE` clauses appended to every query. For the `authenticated` role, every query on a workspace-scoped table includes `workspace_id = ANY(public.my_workspace_ids())`. The composite indexes leading with `workspace_id` (defined in `database-schema.md`) ensure this predicate is resolved by an index scan rather than a sequential scan.

**`my_workspace_ids()` execution cost.** The helper function executes a query against `workspace_members` for every statement that references a workspace-scoped table. Its cost is bounded by the number of workspaces a user belongs to (typically 1–5). The `STABLE` volatility marker allows PostgreSQL to call it once per query plan rather than once per row, but it is still called on every new query. For the MVP with a small number of users per workspace, this is negligible. If workspace membership grows (e.g., team plans with hundreds of members), the function should be replaced with a cached claim embedded in a custom JWT or a materialized security context.

**Partition pruning.** The `activity_log` table is range-partitioned by `created_at`. RLS policies on partitioned tables are applied at the partition level, which means the planner can still prune irrelevant partitions before applying the workspace filter. Policies reference `workspace_id`, not `created_at`, so partition pruning from date range filters in application queries works correctly alongside RLS.

**Avoiding per-row function calls.** Early iterations of RLS policies sometimes use `(SELECT auth.uid())` in the `USING` clause, which forces re-evaluation per row. The current policies use `auth.uid()` directly (a session-level constant) and `my_workspace_ids()` (marked `STABLE`). This avoids the per-row evaluation trap.

---

## Integration with the Rest of the System

**Next.js Server Components and Route Handlers.** The `@supabase/ssr` package creates a request-scoped Supabase client from the session cookie. This client uses the `anon` key but attaches the user's JWT via the `Authorization` header, causing all queries to execute as the `authenticated` role with the correct `auth.uid()`. RLS is transparent to application code; developers simply query the tables and get back only the rows they're entitled to see.

**MCP Edge Function.** The MCP server authenticates API key tokens independently of Supabase Auth. After resolving the API key to a workspace (via a `service_role` query against `api_keys`), all subsequent database queries within the same tool invocation use the workspace ID explicitly rather than relying on RLS. This is a deliberate design: MCP calls are not browser sessions, and attaching a user JWT to each request would require a different authentication model. The Edge Function enforces workspace isolation in application code; it does not rely on RLS for MCP-path queries. All `activity_log` inserts are performed with `service_role` to ensure they succeed regardless of the RLS append-only policy.

**Token Refresh Edge Function.** Runs on a schedule using `service_role`. It queries all active inboxes with expiring tokens across all workspaces, processes them, and writes updated tokens back. RLS is bypassed because `service_role` bypasses it; this is intentional and correct for an administrative background job. The function must not expose data from one workspace to another in its processing logic (isolation is enforced in application code, not by RLS, for this path).

**Supabase Realtime.** Realtime subscriptions are filtered by the same JWT and RLS policies as regular queries. A client subscribing to `activity_log` inserts will only receive events for rows matching the RLS `SELECT` policy — i.e., their own workspace's events. This requires no additional filtering in client code; the Realtime broker applies RLS automatically.

**Database migrations.** New tables must always include `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` as the first post-`CREATE TABLE` statement. Migrations that add new tables without enabling RLS must be rejected in code review. A CI check using `psql` meta-commands verifies that every table in `public` has RLS enabled before the migration is approved.

---

## Migration Checklist

When adding a new table to the schema, the following steps are required:

1. Add `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;` immediately after `CREATE TABLE`.
2. Define explicit `SELECT`, `INSERT`, `UPDATE`, and `DELETE` policies (even if some are intentionally absent — document the reason in a comment).
3. Add a `workspace_id` column with an index if the table is tenant-scoped.
4. Add test assertions in `supabase/tests/rls/<table>.test.sql` covering: access by member of correct workspace, access denied for member of different workspace, access denied for `anon` role, and immutability if applicable.
5. Update this document with the new table's policies.
