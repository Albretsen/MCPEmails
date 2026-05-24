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
| MCP auth | Separate API key system — no session cookie usage |
