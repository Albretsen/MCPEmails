/* Build-time configuration and the mock / HTTP mode switch.
 *
 * Mock mode is used when
 *   - VITE_USE_MOCK=1 (any build), or
 *   - `?mock` is in the URL (dev builds only), or
 *   - the Supabase env is absent (dev builds and tests only).
 * A production build talks HTTP. A production build with no Supabase env and
 * no VITE_USE_MOCK is misconfigured: the app says so instead of pretending.
 */

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  /** `{FUNCTIONS_URL}/client-api`, no trailing slash. */
  apiBase: string;
  useMock: boolean;
  /** HTTP mode was selected but the Supabase env is missing. */
  misconfigured: boolean;
}

export interface ConfigEnv {
  DEV?: boolean;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
  VITE_API_BASE?: string;
  VITE_USE_MOCK?: string;
}

const trim = (s: string | undefined): string => (s ?? "").trim().replace(/\/+$/, "");

export function resolveConfig(env: ConfigEnv, search = ""): AppConfig {
  const supabaseUrl = trim(env.VITE_SUPABASE_URL);
  const supabaseAnonKey = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  const hasEnv = !!supabaseUrl && !!supabaseAnonKey;
  const flag = env.VITE_USE_MOCK === "1" || env.VITE_USE_MOCK === "true";
  const dev = !!env.DEV;
  const urlMock = dev && new URLSearchParams(search).has("mock");
  const useMock = flag || urlMock || (dev && !hasEnv);
  const apiBase = trim(env.VITE_API_BASE) || (supabaseUrl ? `${supabaseUrl}/functions/v1/client-api` : "");
  return { supabaseUrl, supabaseAnonKey, apiBase, useMock, misconfigured: !useMock && !hasEnv };
}

export const config: AppConfig = resolveConfig(
  import.meta.env as ConfigEnv,
  typeof location === "undefined" ? "" : location.search,
);

/**
 * The web app's origin (VITE_WEB_APP_URL) and this client's own origin
 * (VITE_APP_ORIGIN). Both default to production; a staging build sets them.
 */
export function resolveOrigins(env: { VITE_WEB_APP_URL?: string; VITE_APP_ORIGIN?: string }): {
  webAppUrl: string;
  appOrigin: string;
} {
  return {
    webAppUrl: trim(env.VITE_WEB_APP_URL) || "https://mcpemails.com",
    appOrigin: trim(env.VITE_APP_ORIGIN) || "https://app.mcpemails.com",
  };
}

const origins = resolveOrigins(import.meta.env as { VITE_WEB_APP_URL?: string; VITE_APP_ORIGIN?: string });
export const WEB_APP_URL = origins.webAppUrl;
/** Used only where there is no window to read the origin from. */
export const APP_ORIGIN = origins.appOrigin;

/** Where accounts, mailboxes and billing are managed. */
export const DASHBOARD_URL = `${WEB_APP_URL}/dashboard`;
export const DASHBOARD_SETTINGS_URL = `${WEB_APP_URL}/dashboard/settings`;
export const SIGNUP_URL = `${WEB_APP_URL}/signup`;
export const PASSWORD_RESET_URL = `${WEB_APP_URL}/forgot-password`;
