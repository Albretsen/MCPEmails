# Authentication & Session Management

## Purpose

This document describes how MCPEmails handles user authentication, JWT token management, and session lifecycle. It covers the Supabase Auth integration, sign-in flows, token storage, session refresh, server-side access control, and how authentication state flows through both the Next.js frontend and the MCP layer.

---

## Design Decisions

### No Password Authentication (MVP)

MCPEmails does not support username/password login for the MVP. The supported sign-in methods are:

- **Magic link** (email OTP) — primary method; zero password management
- **OAuth sign-in** (Google, GitHub, or Microsoft) — optional, added when user demand justifies it

This reduces attack surface, eliminates password storage risks, and simplifies the auth surface to a single provider (Supabase Auth).

### Supabase Auth as the Identity Layer

Supabase Auth handles:
- User registration and identity records (stored in `auth.users`)
- Token issuance (JWTs signed with the project's JWT secret)
- Session management (refresh token rotation)
- Magic link and OTP delivery

No custom identity server is maintained. All auth state derives from Supabase-issued tokens.

### Cookie-Based Session Storage

Supabase Auth v2 SSR (`@supabase/ssr`) stores the session in **server-readable cookies**, not localStorage. This is deliberate:

- Enables Server Components and Route Handlers to access the session without a client round-trip
- Prevents XSS from exfiltrating tokens from localStorage
- Works with Next.js middleware for route-level access control

The access token and refresh token are stored in a single `sb-<project-ref>-auth-token` cookie with the following attributes:
- `HttpOnly`: true (prevents JavaScript access)
- `Secure`: true (HTTPS only in production)
- `SameSite`: Lax
- `Path`: /
- `MaxAge`: set to the refresh token expiry (default ~1 week)

---

## Supabase Auth Setup

### Client Initialization

MCPEmails maintains three Supabase client configurations:

**1. Browser client** (`utils/supabase/client.ts`)

Used in Client Components only. Created with `createBrowserClient` from `@supabase/ssr`. Reads and writes cookies via the browser's document.cookie API.

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

**2. Server client** (`utils/supabase/server.ts`)

Used in Server Components, Route Handlers, and Server Actions. Created with `createServerClient` from `@supabase/ssr`. Reads cookies from the incoming request and writes Set-Cookie headers on the response.

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

**3. Middleware client** (`utils/supabase/middleware.ts`)

Used in `middleware.ts` to refresh sessions on every request before the response is sent. Uses the request/response objects rather than the Next.js `cookies()` API because middleware cannot call `cookies()` directly.

```typescript
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            supabaseResponse.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // Refresh the session — this is the key call
  const { data: { user } } = await supabase.auth.getUser();

  // Redirect unauthenticated users away from protected routes
  if (!user && isProtectedPath(request.nextUrl.pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.searchParams.set('redirect', request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

function isProtectedPath(pathname: string): boolean {
  const protectedPrefixes = ['/dashboard', '/settings', '/api/mcp'];
  return protectedPrefixes.some((prefix) => pathname.startsWith(prefix));
}
```

---

## Sign-In Flows

### Magic Link Flow

1. User enters their email on `/login`
2. Frontend calls `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: '/auth/callback' } })`
3. Supabase sends a time-limited magic link (valid for 60 minutes by default)
4. User clicks the link → lands on `/auth/callback?code=...`
5. The callback Route Handler exchanges the code for a session:

```typescript
// app/auth/callback/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/dashboard';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Exchange failed — redirect to error page
  return NextResponse.redirect(`${origin}/auth/error`);
}
```

6. Supabase sets the session cookies; middleware will refresh on subsequent requests
7. User is redirected to `/dashboard` (or their original destination via `next` param)

### Sign-Out Flow

1. User clicks Sign Out in the UI
2. Client calls `supabase.auth.signOut()`
3. Supabase clears session cookies and invalidates the refresh token server-side
4. User is redirected to `/login`

The sign-out must also clear any client-side state (cached user data, workspace context). This is handled by a `signOut` Server Action that calls `redirect('/login')` after clearing the session.

---

## JWT Handling

### Token Structure

Every authenticated request carries a Supabase-issued JWT. The JWT payload includes:

| Claim | Value | Purpose |
|-------|-------|---------|
| `sub` | UUID (auth.users.id) | User identity |
| `email` | string | User email |
| `role` | `authenticated` | Postgres role for RLS |
| `aud` | `authenticated` | Audience |
| `exp` | Unix timestamp | Expiry (1 hour by default) |
| `iat` | Unix timestamp | Issued at |

### RLS Integration

When the Supabase client makes a database query, it automatically includes the JWT in the `Authorization: Bearer <token>` header. Supabase's PostgREST layer verifies the JWT and sets `auth.uid()` to the `sub` claim. All RLS policies use `auth.uid()` to filter rows:

```sql
-- Example RLS policy (from the RLS architecture doc)
CREATE POLICY "Users can only access their own workspace"
ON workspaces FOR ALL
USING (user_id = auth.uid());
```

This means even if application code has a bug and omits a `.eq('user_id', ...)` filter, the database enforces isolation.

### Token Expiry and Refresh

Access tokens expire after **1 hour**. The middleware (`updateSession`) calls `supabase.auth.getUser()` on every request, which transparently:

1. Detects if the access token is near expiry
2. Uses the refresh token to obtain a new access token from Supabase
3. Writes updated cookies to the response via the `setAll` cookie callback

Because `getUser()` makes a network call to Supabase Auth to validate the token server-side (rather than just verifying the JWT signature locally), it provides stronger security guarantees — it will detect revoked sessions even if the JWT has not yet expired.

> **Important**: Always call `supabase.auth.getUser()`, never `supabase.auth.getSession()`, in server-side code. `getSession()` only validates the JWT signature locally and does not detect revoked sessions.

---

## Session Lifecycle

```
User opens app
      │
      ▼
Middleware runs on every request
      │
      ├─ No session cookies → redirect to /login
      │
      └─ Session cookies present
            │
            ▼
      supabase.auth.getUser() called
            │
            ├─ Valid session → proceed, refresh cookies if needed
            │
            ├─ Access token expired, valid refresh token → refresh → proceed
            │
            └─ Refresh token expired/revoked → clear cookies → redirect to /login
```

### Session Duration

| Token | Default Duration | Configurable |
|-------|-----------------|--------------|
| Access token | 1 hour | Yes (Supabase dashboard) |
| Refresh token | 7 days | Yes (Supabase dashboard) |
| Magic link | 1 hour | Yes (Supabase dashboard) |

For a SaaS product, the default 7-day refresh token is appropriate. Users who are inactive for 7+ days must re-authenticate, which is acceptable security behaviour.

### Concurrent Sessions

Supabase Auth supports multiple active sessions per user (e.g., desktop + mobile). Each device gets its own refresh token. Revoking one session does not invalidate others unless the user explicitly signs out all sessions via `supabase.auth.signOut({ scope: 'global' })`.

---

## Protected Routes

### Next.js Middleware

The `middleware.ts` at the project root applies `updateSession` to every request and redirects unauthenticated users. The middleware matcher is scoped to avoid running on static assets:

```typescript
// middleware.ts
import { updateSession } from '@/utils/supabase/middleware';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

### Server Component Auth Check

In Server Components where auth context is needed beyond route-level protection, call `getUser()` directly to get the user object:

```typescript
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    redirect('/login');
  }

  // user is now guaranteed to be authenticated
  const { data: workspaces } = await supabase.from('workspaces').select();
  // ...
}
```

### Route Handler Auth Check

Route Handlers (used for API endpoints consumed by the frontend) must also verify the session:

```typescript
// app/api/inboxes/route.ts
import { createClient } from '@/utils/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: inboxes } = await supabase.from('inboxes').select();
  return NextResponse.json({ inboxes });
}
```

Because RLS enforces data isolation at the database level, even a bug in application code that skips the `getUser()` check would be contained — queries would return no rows for an unauthenticated request (since `auth.uid()` would be null).

---

## User Onboarding

On first sign-in, a new user record must be provisioned in the public schema and a default workspace created. This is handled by a Supabase database trigger:

```sql
-- Trigger: auto-create workspace on first sign-in
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.workspaces (user_id, name, slug)
  VALUES (
    NEW.id,
    SPLIT_PART(NEW.email, '@', 1),
    LOWER(REGEXP_REPLACE(SPLIT_PART(NEW.email, '@', 1), '[^a-z0-9]', '-', 'g'))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

The trigger runs with `SECURITY DEFINER` to bypass RLS when inserting the initial workspace row, since `auth.uid()` is not yet set in the trigger context.

---

## Security Considerations

### XSS Protection

- Session tokens are stored in `HttpOnly` cookies, inaccessible to JavaScript
- The Content-Security-Policy header must be set to prevent script injection
- No sensitive data is written to localStorage

### CSRF Protection

- The Next.js middleware uses `SameSite=Lax` cookies, which prevents cross-site form submissions from carrying auth cookies
- For state-changing Route Handlers, the Supabase session cookie provides implicit CSRF protection because the cookie is not readable by foreign origins
- The OAuth callback (`/auth/callback`) uses the PKCE flow (Supabase default) which includes a per-request code verifier, preventing authorization code interception

### Rate Limiting on Auth Endpoints

Supabase Auth applies its own rate limits on magic link sends (by default: 60 emails per hour per project). At the application level, `/login` submissions are rate-limited via the Edge Function middleware layer to prevent enumeration and spam. See the Rate Limiting architecture document for details.

### Session Revocation

- **Individual sign-out**: Invalidates only the current device's refresh token
- **Global sign-out**: Invalidates all refresh tokens for the user (`scope: 'global'`)
- **Admin revocation**: Supabase dashboard or Admin API can delete sessions for a user — useful for account compromise scenarios

### Logging

Every authentication event (sign-in, sign-out, token refresh failure, magic link sent) is recorded to the `auth_logs` table by a Supabase Auth hook. This enables security auditing and anomaly detection. The logged fields include:

- `user_id`
- `event_type` (`sign_in`, `sign_out`, `token_refresh`, `magic_link_sent`, `auth_error`)
- `ip_address`
- `user_agent`
- `created_at`

---

## Integration with the MCP Layer

The MCP layer uses a separate authentication mechanism (API keys) rather than user session JWTs. When an MCP client connects, it authenticates with a bearer token (API key), not a session cookie. This distinction is important:

- **Dashboard / frontend**: session cookie auth via Supabase Auth
- **MCP endpoints**: API key auth via the `api_keys` table

There is no cross-contamination between these two auth systems. A session cookie cannot be used to call MCP tools, and an API key cannot be used to access the Next.js dashboard. See the MCP Authentication Flow document for full details.

---

## Environment Variables

| Variable | Scope | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only | Service role key (bypasses RLS); used only in Edge Functions |

The `SUPABASE_SERVICE_ROLE_KEY` must never be exposed to the client bundle. It is used only in Supabase Edge Functions for administrative operations like provisioning resources triggered by auth events.

---

## Summary

| Concern | Decision |
|---------|----------|
| Sign-in method | Magic link (email OTP) |
| Token storage | HttpOnly cookies via `@supabase/ssr` |
| Session refresh | Automatic in middleware via `getUser()` |
| Route protection | Next.js middleware + Server Component guard |
| Data isolation | Supabase RLS enforced at database level |
| Token validation | Server-side via `getUser()` (not local JWT verify) |

---

## Pricing & Quota Implementation Plan

Tracks the work required to ship the four-tier pricing model (Free / Solo / Pro / Enterprise) with monthly call caps and daily burst limits.

### Agreed tier structure

| | Free | Solo | Pro | Enterprise |
|---|---|---|---|---|
| Price | $0 | $9 / mo · $7 annual | $29 / mo · $23 annual | Custom |
| Monthly call cap | 500 | 3,000 | 20,000 | Unlimited |
| Daily burst cap | 100 | 500 | 2,000 | Custom |
| Connected inboxes | 1 | 3 | 10 | Unlimited |
| API keys | 1 | 3 | 10 | Unlimited |
| Analytics | — | — | ✓ | ✓ |
| Support | Community | Community | Email | Dedicated + SLA |
| Free trial | — | 14 days | 14 days | — |

Monthly cap = total calls allowed in a UTC calendar month. Daily burst cap = ceiling on any single UTC calendar day, regardless of monthly balance. The burst cap prevents a runaway agent from consuming the full monthly allowance in one session.

---

### Phase 1 — Canonical plan definitions `[x]`

**Goal:** Single source of truth for all plan limits, prices, and identifiers. Everything else reads from here.

**File:** `apps/web/src/lib/stripe/plans.ts`

- Add `'solo'` to the `PlanId` type
- Add `maxDailyBurstCalls: number` to the `PlanLimits` interface (currently missing)
- Define all four plans with the agreed numbers above
- Reconcile existing Pro discrepancy: currently $19/month with 5 inboxes — update to $29/month, 10 inboxes
- Add env var slots: `STRIPE_PRICE_SOLO_MONTHLY`, `STRIPE_PRICE_SOLO_YEARLY`
- Update each plan's `features` array (consumed by the pricing UI)

No deployment needed — build-time only. Unblocks all other phases.

---

### Phase 2 — Edge function: monthly cap + Solo `[x]`

**Goal:** The MCP server enforces both a monthly total cap and a daily burst cap.

**File:** `supabase/functions/mcp-server/index.ts`

- Replace the hardcoded `PLAN_DAILY_CALL_CAPS` map with two maps: `PLAN_DAILY_BURST_CAPS` and `PLAN_MONTHLY_CAPS`
- Add `solo` entries to both maps
- Extend `PlanQuotaResult` with `monthlyUsed`, `monthlyCap`, `quotaType: 'daily_burst' | 'monthly_total'`
- Extend `checkPlanQuota` to: (1) count `activity_log` rows for the current UTC calendar month, (2) block on monthly cap first with `error_code: "quota_exceeded"`, (3) block on daily burst with `error_code: "rate_limit_exceeded"` and `window: "daily_burst"`
- Update `buildQuotaExceededResponse` so `human_message` quotes the correct limit type and numbers

**Deployment:** `npx supabase functions deploy mcp-server --project-ref swvaxorwumispmjaaszb --no-verify-jwt`

**Future (Phase 2b):** When call volume warrants it, replace the `COUNT(activity_log)` monthly query with an upsert on a `monthly_usage (workspace_id, year_month, call_count)` table. The COUNT query is acceptable at current scale.

---

### Phase 3 — Stripe: Solo tier `[x]`

**Goal:** Users can subscribe to the Solo plan via Stripe checkout.

**Pre-code manual step:** Create Solo product + two prices in the Stripe dashboard ($9/month, $84/year). Copy `price_...` IDs into Vercel env vars as `STRIPE_PRICE_SOLO_MONTHLY` and `STRIPE_PRICE_SOLO_YEARLY`.

**Files:**
- `apps/web/app/api/stripe/checkout/route.ts` — extend `planId` validation to include `'solo'`
- `apps/web/app/api/stripe/webhook/route.ts` — extend plan ID validation to include `'solo'`

The rest of the Stripe machinery (`getPlanByStripePriceId`, `syncWorkspacePlan`, subscription updated/deleted events) already handles any plan ID generically via `plans.ts`.

---

### Phase 4 — API key limit enforcement `[ ]`

**Goal:** Creating more API keys than the plan allows is blocked at the API layer.

Inbox limits already work end-to-end via `check-inbox-limit.ts`. API key limits have the definition in `plans.ts` (`maxApiKeys`) but no enforcement at the creation endpoint.

**New file:** `apps/web/src/lib/plans/check-api-key-limit.ts`
Mirrors `check-inbox-limit.ts`: two parallel queries (workspace plan + count of non-deleted API keys + OAuth connections), returns `{ atLimit, plan, currentCount, maxApiKeys }`.

**Modified file:** `apps/web/app/api/api-keys/route.ts` POST handler
Call `checkApiKeyLimit` before creating a key. Return 403 with `error_code: "api_key_limit_reached"` and `upgrade_url: "/pricing"` if at cap.

**Also verify:** Gmail and Outlook OAuth inbox-connect routes call `checkInboxLimit` (the Fastmail route already does).

---

### Phase 5 — Dashboard: usage display `[ ]`

**Goal:** Users can see monthly call usage and plan limits. Prevents the "why did my agent stop working?" problem.

**Requires:** Phase 2 live (monthly counter in edge function).

**New API route:** `GET /api/usage`
Returns `{ plan, monthly: { used, cap, resets_at }, daily_burst: { used, cap, resets_at } }`. Runs two `COUNT` queries against `activity_log` (same queries the edge function runs).

**Dashboard changes:**
- Usage card on main dashboard: `X / Y calls this month` with a progress bar
- Secondary daily burst indicator
- Upgrade CTA when monthly usage crosses 80%
- Settings → Billing page: same data alongside plan name and billing portal link

---

### Phase 6 — Marketing copy `[ ]`

**Goal:** All public pricing pages reflect the four-tier structure with correct numbers.

No backend dependency — can land any time after Phase 1 numbers are locked.

**Files:**
- `apps/web/components/marketing/Sections.jsx` — rebuild pricing widget for 4 tiers; fix all numbers
- `apps/web/components/marketing/PricingClient.jsx` — add Solo column to plan cards and comparison table; update FAQ
- `apps/web/components/marketing/DocsClient.jsx` — update rate limits section to correctly describe monthly cap + daily burst model; remove stale "100 calls / month" in CTA band

---

### Dependency order

```
Phase 1 (plans.ts — source of truth)
        │
        ├─── Phase 2 (edge function enforcement)
        │         │
        │         └─── Phase 5 (dashboard usage display)
        │
        ├─── Phase 3 (Stripe Solo tier)
        │         │
        │         └─── Phase 4 (API key limits)
        │
        └─── Phase 6 (marketing copy)
```

Minimum viable ship: Phases 1 + 2 + 3 + 6. Enforcement is correct, Solo is purchasable, marketing reflects reality. Phases 4 and 5 are correctness and UX improvements that can follow.
| MCP auth | Separate API key system — no session cookie usage |
