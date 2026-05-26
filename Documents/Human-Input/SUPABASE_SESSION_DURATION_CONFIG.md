# Set Session Duration to 60 Days

## What needs to change

The refresh token expiry needs to be extended from the default 7 days to 60 days so users stay signed in across normal usage gaps without being forced to re-authenticate.

## Where to make the change

**Supabase Dashboard → Authentication → Configuration**

Direct link: https://supabase.com/dashboard/project/swvaxorwumispmjaaszb/auth/configuration

Under the **"User Sessions"** section:

| Setting | Current (default) | Target value |
|---|---|---|
| Refresh token expiry | 604800 (7 days) | **5184000** (60 days) |

Click **Save**.

## Why 60 days

The access token (JWT) still expires every hour and is silently refreshed by the middleware on every request. The refresh token is only consumed when a user returns after the access token has expired. With a 7-day window, any user inactive for a week gets kicked out. With 60 days, only users who haven't opened the app in two months will see a sign-in prompt.

## Verification

After saving, sign in and note the session cookie's `Max-Age` value in browser DevTools → Application → Cookies. It should be approximately `5184000` seconds (or the expiry date ~60 days out).
