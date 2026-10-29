// ---------------------------------------------------------------------------
// Ask the web app to send a Free allowance notice now.
//
// The three allowance notices (usage_warning_80, usage_limit_reached,
// automation_paused_limit) are queued by this function straight into
// `billing_email_sends`, and sent by the web app's dispatcher
// (apps/web/app/api/internal/billing-lifecycle/dispatch). pg_cron calls that
// dispatcher every five minutes; without this, a notice could wait that long.
// After a successful insert, `kickBillingDispatch` POSTs the dispatcher with
// `?mode=emails` (send what is due, nothing else) and the same
// X-Dispatch-Secret the cron uses.
//
// FIRE AND FORGET. The POST runs under EdgeRuntime.waitUntil where there is
// one, with a short timeout, and is never awaited by the tool call. A missing
// secret, a timeout or a 500 is logged and nothing else: the row is queued and
// due, so the five-minute cron still sends it. The dispatcher claims rows
// atomically, so this racing the cron cannot send a notice twice.
// ---------------------------------------------------------------------------

import { backgroundRuntime, type BackgroundRuntime } from "./request-pipeline.ts";

/** Long enough for the dispatcher to claim and send one row, short enough to never matter. */
export const KICK_TIMEOUT_MS = 8_000;

export interface KickOptions {
  /** DISPATCH_SECRET. Missing or empty: skipped. */
  secret: string | undefined | null;
  /** The web app origin (APP_URL). Missing or empty: skipped. */
  appUrl: string | undefined | null;
  fetchImpl?: typeof fetch;
  runtime?: BackgroundRuntime | null;
  timeoutMs?: number;
}

/** The dispatcher URL for `appUrl`, or null when there is no usable origin. */
export function dispatchUrl(appUrl: string | undefined | null): string | null {
  const base = (appUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return null;
  return `${base}/api/internal/billing-lifecycle/dispatch?mode=emails`;
}

/**
 * Starts the POST and returns at once. Returns false when it was skipped (no
 * secret or URL), true when started. Never throws, never rejects.
 */
export function kickBillingDispatch(options: KickOptions): boolean {
  try {
    const url = dispatchUrl(options.appUrl);
    if (!options.secret || !url) {
      console.warn("[mcp-server] billing_dispatch_kick_skipped", {
        reason: !options.secret ? "no_dispatch_secret" : "no_app_url",
      });
      return false;
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? KICK_TIMEOUT_MS;

    const task = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "X-Dispatch-Secret": options.secret as string },
          signal: controller.signal,
        });
        // Drain the body so the connection is released.
        await response.body?.cancel().catch(() => {});
        if (!response.ok) {
          console.warn("[mcp-server] billing_dispatch_kick_failed", { status: response.status });
        }
      } catch (error) {
        console.warn("[mcp-server] billing_dispatch_kick_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timer);
      }
    })();

    const runtime = options.runtime === undefined ? backgroundRuntime() : options.runtime;
    try {
      runtime?.waitUntil?.(task);
    } catch {
      // A hook that refuses the work: the task is already running regardless.
    }
    return true;
  } catch (error) {
    console.warn("[mcp-server] billing_dispatch_kick_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
