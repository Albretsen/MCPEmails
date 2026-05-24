# Data Fetching Strategy

## Purpose

This document defines how MCPEmails fetches data at every layer of the Next.js 15 application — from Server Components that render on the edge to client-side mutations that must feel instantaneous. Every decision here has a reason; nothing is "to be decided later."

---

## 1. Guiding Principle

**Server Components fetch by default. Client Components fetch only when interactivity demands it.**

Next.js 15 App Router makes Server Components the default. A Server Component renders once on the server, can `await` any async call directly in its body, and sends HTML to the browser — no JavaScript bundle, no loading flash, no hydration cost for the data layer.

A Client Component (`'use client'`) ships JavaScript to the browser, owns local state, and can respond to user events. It should fetch data only when one of these conditions is true:

- The data changes in response to a user action that has already happened (e.g., filtering a list the user just typed into).
- The data must be kept live via a real-time subscription (Supabase Realtime for the activity feed).
- The component is entirely below a Suspense boundary and the fetch is needed to populate a secondary UI that is not part of the initial page render.

If a fetch does not meet one of those conditions, it belongs in a Server Component or a Server Action. Moving a fetch to the client to "keep things simple" is the single most common performance mistake in Next.js App Router projects.

---

## 2. Supabase Server Client Pattern

The server client is used in Server Components, Route Handlers, and Server Actions. It reads session cookies from the incoming request and can write `Set-Cookie` headers back — enabling automatic token refresh on every server-side call without any client-side involvement.

**File: `apps/web/utils/supabase/server.ts`**

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/types/database';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        },
      },
    }
  );
}
```

**Rules for the server client:**

- Always `await createClient()`. The `cookies()` API in Next.js 15 is async.
- Never pass the client across a Server/Client boundary. Create a new one inside each Server Component or Route Handler.
- The anon key is correct here. Row-Level Security on all tenant tables ensures users can only see their own workspace data. The service-role key is only used in Supabase Edge Functions that run administrative tasks.
- The client is not a singleton. Next.js caches at the `fetch()` level, not at the client instance level.

---

## 3. Supabase Browser Client Pattern

The browser client is used in Client Components that need to call Supabase directly — primarily for real-time subscriptions and auth state observation. It reads and writes cookies via `document.cookie`.

**File: `apps/web/utils/supabase/client.ts`**

```typescript
import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '@/types/database';

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

**When to use the browser client:**

- Supabase Realtime subscriptions (e.g., `supabase.channel('activity').on(...)`) for the live activity feed on the Overview page.
- Auth state listeners (`supabase.auth.onAuthStateChange`) if a component needs to react to sign-out.
- Any future optimistic-read pattern where you want to subscribe to a table and merge server changes into local state.

**When not to use the browser client:**

- Do not use it to load initial page data. That data belongs in a Server Component.
- Do not use it to perform mutations like creating API keys or disconnecting inboxes. Those mutations go through Route Handlers or Server Actions so auth is verified server-side before anything changes.

The browser client should be instantiated once per component that needs it, typically inside a `useMemo` or as a module-level singleton — not recreated on every render.

---

## 4. Dashboard Data Fetching

The dashboard is currently a single large Client Component tree rooted at `DashboardApp` in `components/dashboard/App.jsx`. All state — inboxes, API keys, activity — is held in `useState` and seeded from in-memory constants. This is appropriate for the prototype stage but must be replaced with real server-side fetching as the backend is built out.

The target architecture for each dashboard section is as follows.

### `app/dashboard/page.js` (the shell)

This is a Server Component. It fetches the user's workspace record and passes it as props into the dashboard subtree. It also sets `metadata` for the page title.

```typescript
// app/dashboard/page.tsx
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';
import { DashboardApp } from '@/components/dashboard/App';

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('id, slug, display_name, plan')
    .eq('owner_id', user.id)
    .single();

  if (!workspace) redirect('/onboarding');

  return <DashboardApp workspaceId={workspace.id} plan={workspace.plan} />;
}
```

**Why server-side:** The workspace record is required to render any dashboard content. Fetching it server-side means the page never flickers through an unauthenticated or workspace-less state. The redirect to `/login` is handled before any HTML is sent to the browser.

### Overview page — server-side

Inbox count, live-inbox count, 30-day call total, and plan usage percentage are all aggregate reads. They are fetched in a Server Component wrapper that wraps `OverviewPage`. The activity feed (the live ticker) is the only element that uses a Realtime subscription, and that subscription is established by a small Client Component mounted inside the otherwise-server-rendered page.

**Why server-side for aggregates:** These numbers do not change in response to user input on this page. Fetching them server-side avoids a loading skeleton for the stat grid and ensures the numbers are correct on first paint.

### Inboxes page — server-side initial load, client-side for mutations

The inbox list is fetched in a Server Component and passed as the initial `inboxes` prop to the `InboxesPage` Client Component. After the user connects or removes an inbox (a mutation), the client uses `router.refresh()` to re-run the server-side fetch and get the updated list, rather than manually splicing arrays.

**Why this split:** The list itself is a read with no interactivity requirements — it should arrive on first paint. But connect and remove are multi-step async operations (OAuth handoff, API call, error handling) that belong in Client Components with local state for the in-progress flow. The actual database write goes through a Route Handler.

### API Keys page — server-side initial load, client-side for reveal/copy

The key list (including redacted token values) is fetched server-side. The "reveal token" and "copy to clipboard" interactions are client-side only — they do not touch the server. Creating and revoking keys goes through Route Handlers.

**Why server-side for the list:** API keys contain sensitive metadata (scopes, last-used timestamps) that should not be fetched in a client waterfall. Rendering them on the server also avoids a layout shift where the table appears empty then populates.

**Why the token reveal is client-side:** Revealing the full token value is a UI-only state toggle. The full token was fetched and delivered server-side (redacted in the HTML, but available in the React component tree for the reveal toggle). No additional network request is needed.

### Usage page — server-side

Call counts, plan limits, and per-tool breakdowns are all fetched in a Server Component. The "Export CSV" button triggers a Route Handler that streams the data.

**Why server-side:** This is a read-heavy analytics view with no user-driven filtering on MVP. All data can be fetched in one server round-trip.

### Settings page — Server Component with Server Action mutations

The workspace name, region, and billing data are fetched server-side and pre-filled into the form. The "Save changes" form submits via a Server Action. The "Delete workspace" button submits via a Server Action that redirects to `/` on success.

**Why Server Actions here instead of Route Handlers:** Settings mutations are simple form submissions. Server Actions integrate directly with HTML `<form>` elements, do not require a separate API endpoint, and handle progressive enhancement out of the box.

### Security page — server-side

The audit log is fetched server-side, paginated (20 entries per page, cursor-based). The log is append-only, so there is no polling — the user refreshes the page or uses the "Load more" button, which is a Server Action that appends the next cursor page.

---

## 5. Caching Strategy

### Next.js `fetch()` cache

MCPEmails uses the default Next.js `fetch()` cache behavior (equivalent to `cache: 'force-cache'`) only for genuinely static data — specifically, email provider OAuth endpoint metadata fetched at build time. All user-data fetches use `cache: 'no-store'` or are performed via the Supabase JavaScript client (which uses `fetch` internally with `cache: 'no-store'` by default in the SSR package).

Do not add `cache: 'force-cache'` to Supabase queries without an explicit revalidation strategy. User data changes and must not be served stale.

### `revalidatePath` and `revalidateTag` after mutations

After any mutation that changes data visible on a dashboard page, call `revalidatePath` (or `revalidateTag`) to purge the Next.js full-route cache for that route segment.

```typescript
// In a Route Handler or Server Action after a successful mutation:
import { revalidatePath } from 'next/cache';

// After connecting or removing an inbox:
revalidatePath('/dashboard');          // purges the whole dashboard shell
revalidatePath('/dashboard/inboxes'); // or scope to just the inboxes segment

// After creating or revoking an API key:
revalidatePath('/dashboard/keys');
```

Use `revalidateTag` when the same dataset is referenced from multiple routes. For example, `inboxes` data appears on both the Overview and Inboxes pages — tagging the fetch and invalidating the tag on mutation is cleaner than calling `revalidatePath` twice.

```typescript
// In the Server Component fetch:
const { data: inboxes } = await supabase
  .from('inboxes')
  .select('...')
  .eq('workspace_id', workspaceId);
// Tag this fetch so it can be invalidated by name:
fetch(`/api/internal/inboxes?workspace=${workspaceId}`, {
  next: { tags: ['inboxes'] }
});

// In the mutation handler:
revalidateTag('inboxes');
```

### When to use `no-store`

Always use `cache: 'no-store'` (or its equivalent) for:

- Any fetch that includes user-specific data (inboxes, keys, activity, usage).
- Any fetch in a Route Handler that responds to a POST/PATCH/DELETE — these must never be cached.
- The activity log — it changes every time an MCP tool is called and must always be fresh.

---

## 6. Optimistic Updates

Optimistic updates are applied when the mutation is cheap to reverse and the latency of the server round-trip would cause a noticeable freeze. The two canonical cases in MCPEmails are API key revocation and inbox removal.

### Pattern

1. Capture the current state before the mutation.
2. Apply the change to local state immediately.
3. Fire the server request in the background.
4. On success: call `router.refresh()` to sync server state (catches any server-side side effects like cascade deletes or computed fields).
5. On error: revert local state to the captured snapshot and surface an error toast.

```typescript
// components/dashboard/KeysPage.tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface ApiKey {
  id: string;
  name: string;
  token: string;
  scopes: string[];
  lastUsed: string;
}

interface KeysPageProps {
  initialKeys: ApiKey[];
  workspaceId: string;
}

export function KeysPage({ initialKeys, workspaceId }: KeysPageProps) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const revokeKey = (keyId: string) => {
    // 1. Capture current state for rollback
    const previousKeys = keys;

    // 2. Apply optimistic change immediately
    setKeys((current) => current.filter((k) => k.id !== keyId));

    // 3. Fire server request
    startTransition(async () => {
      const response = await fetch(`/api/keys/${keyId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        // 5. Revert on error
        setKeys(previousKeys);
        // Surface error — showToast is a shared utility
        showToast('Failed to revoke key. Please try again.', 'error');
        return;
      }

      // 4. Sync server state — triggers revalidatePath on the server
      router.refresh();
      showToast('API key revoked.', 'neutral');
    });
  };

  // ... render
}
```

The same pattern applies to inbox connect and disconnect. For inbox connect, the optimistic insert uses a temporary client-generated UUID that is replaced by the real server UUID after `router.refresh()`.

### What not to make optimistic

- Anything that cannot be cleanly reverted: workspace deletion, plan downgrades.
- Anything where the server computes a value the client cannot predict: the actual API key token string (only shown once, generated server-side). The key row is added optimistically with a placeholder `"Generating..."` token, and `router.refresh()` replaces it.

---

## 7. Loading States

### Page-level: Suspense + `loading.js`

Each route segment that contains async Server Components wraps its content in a Suspense boundary. Next.js automatically uses `loading.js` files as the Suspense fallback for the entire segment.

```
app/
  dashboard/
    loading.tsx        ← shown while page.tsx awaits async data
    page.tsx
    inboxes/
      loading.tsx      ← shown while the inboxes segment loads
      page.tsx
    keys/
      loading.tsx
      page.tsx
```

The `loading.tsx` file for the dashboard shell renders a skeleton that matches the layout of the real content — sidebar is static (always rendered), main column shows card-shaped skeletons. This prevents layout shift when the real data arrives.

```typescript
// app/dashboard/loading.tsx
export default function DashboardLoading() {
  return (
    <div className="page">
      <div className="page-header">
        <div className="skeleton" style={{ width: 160, height: 28 }} />
        <div className="skeleton" style={{ width: 120, height: 36 }} />
      </div>
      <div className="stat-grid">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="stat skeleton-card" />
        ))}
      </div>
    </div>
  );
}
```

### Component-level: `isLoading` props

Client Components that perform their own async operations (e.g., the ConnectModal running an IMAP connection test) accept an `isLoading` boolean prop and render inline loading indicators — spinner icons, disabled buttons, progress text — rather than replacing the whole component with a skeleton.

This distinction is intentional: page-level skeletons are for initial data loads; component-level loading props are for in-place async operations the user explicitly triggered.

---

## 8. Error Boundaries

### `error.js` files per route segment

Every route segment that fetches data has a companion `error.tsx` file. Next.js automatically wraps the segment's content in a React error boundary that catches thrown errors and renders the `error.tsx` fallback.

```
app/
  dashboard/
    error.tsx          ← catches errors thrown by dashboard/page.tsx or its children
    page.tsx
    inboxes/
      error.tsx
      page.tsx
```

The `error.tsx` component receives `error` and `reset` props. It renders a non-destructive error card within the existing dashboard chrome (sidebar remains visible) with a "Try again" button that calls `reset()`.

```typescript
// app/dashboard/error.tsx
'use client';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: ErrorPageProps) {
  return (
    <div className="page">
      <div className="card" style={{ maxWidth: 480 }}>
        <div className="card-h">
          <div className="title" style={{ color: 'var(--red-700)' }}>
            Something went wrong
          </div>
        </div>
        <div className="card-body">
          <p style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--fg-2)' }}>
            We could not load this page. The error has been logged.
          </p>
          {error.digest && (
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>
              Ref: {error.digest}
            </code>
          )}
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-secondary" onClick={reset}>
              Try again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**What surfaces to the user:**

- Page-level errors (failed Supabase queries, network timeouts, workspace not found) are caught by `error.tsx` and show the error card above.
- Mutation errors (failed key revocation, failed inbox connect) are caught in the Client Component's try/catch and shown as toast notifications. They never trigger the error boundary because mutations happen inside event handlers, not during render.
- Auth errors (expired session, RLS policy violation returning an error) are caught by middleware before the page renders and redirect to `/login`.

**What is never shown to the user:**

Stack traces, Supabase error details, SQL state codes, or any internal error messages. The `error.digest` is a short opaque hash that can be correlated with server logs. The user sees only a generic message and the retry option.

---

## 9. Route Handlers (API Routes)

### When to use Route Handlers

Use a Route Handler (`app/api/.../route.ts`) when:

- An external system must call the endpoint (MCP clients, OAuth redirect URIs, Stripe webhooks).
- The operation is a long-running streaming response.
- You need full control over the HTTP response — status codes, headers, streaming body.
- The mutation is triggered by a non-form interaction (e.g., a button click in a Client Component that uses `fetch`).

Do not use Route Handlers for form submissions or simple inline mutations triggered by Server Components. Those belong in Server Actions.

### Naming convention

```
app/api/
  inboxes/
    route.ts           ← GET (list), POST (connect)
    [inboxId]/
      route.ts         ← GET (single), PATCH (update label), DELETE (disconnect)
  keys/
    route.ts           ← GET (list), POST (create)
    [keyId]/
      route.ts         ← DELETE (revoke)
  usage/
    route.ts           ← GET (current period stats)
    export/
      route.ts         ← GET (streaming CSV export)
  mcp/
    [workspaceSlug]/
      route.ts         ← POST (MCP JSON-RPC endpoint; accepts bearer token auth)
  auth/
    callback/
      route.ts         ← GET (OAuth code exchange)
```

### Auth pattern in Route Handlers

Every Route Handler that touches user data must authenticate the caller before doing anything else. The pattern is:

```typescript
// app/api/inboxes/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export async function GET() {
  const supabase = await createClient();

  // Always use getUser(), never getSession() — getUser() validates the JWT
  // against Supabase Auth on every call; getSession() only reads the cookie.
  const { data: { user }, error: authError } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Resolve the workspace — all data is scoped to a workspace, not a user directly.
  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  // RLS further enforces workspace_id isolation at the DB level.
  const { data: inboxes, error } = await supabase
    .from('inboxes')
    .select('id, label, address, provider, status, calls_30d')
    .eq('workspace_id', membership.workspace_id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[GET /api/inboxes]', error.message);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  return NextResponse.json({ inboxes });
}
```

The MCP endpoint (`/api/mcp/[workspaceSlug]`) is the exception: it authenticates with a bearer token (`mcpe_live_...`) from the `Authorization` header, not a session cookie. It validates the token against the `api_keys` table and resolves the associated workspace independently.

---

## 10. Server Actions

### When to use Server Actions

Use a Server Action when:

- A form submission mutates server state and you want progressive enhancement (works without JS).
- The mutation is a simple, synchronous-feeling operation that does not require streaming or custom HTTP headers.
- You want to co-locate the mutation logic with the Server Component that owns the form.

The canonical Server Action cases in MCPEmails are:

- Updating workspace name or region (Settings page form submit).
- Deleting the workspace (Settings page danger action).
- Loading more audit log entries (Security page "Load more").

### How Server Actions interact with the Supabase server client

Server Actions run in the Node.js runtime, have access to `cookies()`, and use the same `createClient()` from `utils/supabase/server.ts` as Server Components. The session is automatically available.

```typescript
// app/dashboard/settings/actions.ts
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import { z } from 'zod';

const updateWorkspaceSchema = z.object({
  displayName: z.string().min(2).max(64),
  region: z.enum(['us-iad', 'eu-fra', 'ap-syd']),
});

export async function updateWorkspace(formData: FormData) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Validate input at the server boundary — never trust client-side validation alone.
  const parsed = updateWorkspaceSchema.safeParse({
    displayName: formData.get('displayName'),
    region: formData.get('region'),
  });

  if (!parsed.success) {
    // Return structured error; the form component reads this via useActionState.
    return { error: parsed.error.flatten().fieldErrors };
  }

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('workspace_id, role')
    .eq('user_id', user.id)
    .single();

  if (!membership || membership.role !== 'owner') {
    return { error: { root: ['Only the workspace owner can change settings.'] } };
  }

  const { error } = await supabase
    .from('workspaces')
    .update({
      display_name: parsed.data.displayName,
      region: parsed.data.region,
    })
    .eq('id', membership.workspace_id);

  if (error) {
    console.error('[updateWorkspace]', error.message);
    return { error: { root: ['Something went wrong. Please try again.'] } };
  }

  revalidatePath('/dashboard/settings');
  return { success: true };
}
```

The form component uses `useActionState` (React 19 / Next.js 15) to read the returned error object and display field-level errors without a page navigation:

```typescript
// components/dashboard/SettingsForm.tsx
'use client';

import { useActionState } from 'react';
import { updateWorkspace } from '@/app/dashboard/settings/actions';

export function SettingsForm({ workspace }: { workspace: Workspace }) {
  const [state, formAction, isPending] = useActionState(updateWorkspace, null);

  return (
    <form action={formAction}>
      <div className="field">
        <label htmlFor="displayName">Workspace name</label>
        <input
          id="displayName"
          name="displayName"
          className={`input${state?.error?.displayName ? ' err' : ''}`}
          defaultValue={workspace.displayName}
        />
        {state?.error?.displayName && (
          <div className="err-msg">{state.error.displayName[0]}</div>
        )}
      </div>
      {/* region select ... */}
      <button type="submit" className="btn btn-primary" disabled={isPending}>
        {isPending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}
```

### Server Actions vs Route Handlers — decision rule

| Situation | Use |
|-----------|-----|
| HTML form with progressive enhancement | Server Action |
| `fetch()` call from a Client Component button | Route Handler |
| Mutation that needs a custom HTTP status code | Route Handler |
| External webhook or OAuth callback | Route Handler |
| Simple form field update in a settings panel | Server Action |
| Streaming or chunked response | Route Handler |
| Inline "Load more" pagination | Server Action |

---

## Summary of Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Default data fetching location | Server Components | Eliminates client waterfalls, ships HTML to browser immediately |
| Supabase client on server | `createServerClient` via `@supabase/ssr` | Cookie-based session; works in RSC and Route Handlers |
| Supabase client on browser | `createBrowserClient` via `@supabase/ssr` | Only for Realtime subscriptions and auth state listeners |
| Auth check in Route Handlers | `supabase.auth.getUser()` | Validates JWT server-side; `getSession()` is client-only |
| Mutation response after optimistic update | `router.refresh()` | Re-runs server fetch, syncs any server-computed fields |
| Cache invalidation after mutations | `revalidatePath` / `revalidateTag` | Purges Next.js full-route cache without a full redeploy |
| Form mutations | Server Actions + `useActionState` | Progressive enhancement; field-level error returns without navigation |
| Non-form client mutations | Route Handlers | Full HTTP control; callable from any Client Component |
| Error surfaces | `error.tsx` per segment + toast for mutations | Keeps dashboard chrome visible; mutations fail in-place |
| Loading states | `loading.tsx` per segment + inline `isLoading` props | Page-level skeletons for data loads; inline for user-triggered async |

---

**Version**: 1.0
**Last Updated**: 2026-05-24
**Next Review**: 2026-06-24
