// ---------------------------------------------------------------------------
// app-env.ts - which deployment this is, and the web origin it links to.
//
// APP_ENV is `production` unless set. APP_URL drives reconnect links, checkout
// links, the billing kick and the OAuth `resource_metadata` challenge, so a
// staging deploy that forgot it would point Claude at production's OAuth
// server. Outside production it is therefore required, and a missing value
// fails the function at boot instead of quietly defaulting to mcpemails.com.
// ---------------------------------------------------------------------------

export const PRODUCTION_APP_URL = "https://mcpemails.com";

export function resolveAppEnv(raw: string | undefined): string {
  return raw?.trim().toLowerCase() || "production";
}

export function resolveAppUrl(env: { APP_ENV?: string; APP_URL?: string }): string {
  const appEnv = resolveAppEnv(env.APP_ENV);
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");
  if (appUrl) return appUrl;
  if (appEnv !== "production") {
    throw new Error(
      `APP_URL is required when APP_ENV=${appEnv}. Set it to this deployment's web origin ` +
        `(for example https://staging.mcpemails.com); it never defaults to production outside production.`,
    );
  }
  return PRODUCTION_APP_URL;
}
