// ---------------------------------------------------------------------------
// Tell the workspace owner that an endpoint was disabled.
//
// Customer email is sent by the web app (Resend, apps/web/src/lib/email), not
// from the edge. So the dispatcher asks the web app to do it: one POST to
// /api/internal/webhook-disabled with the endpoint id and the shared
// X-Dispatch-Secret, the same trust boundary system-notify uses for
// /api/internal/growth-expire. The web route reads the endpoint and the
// owner's address itself; nothing about the endpoint travels in this call
// except its id. Best effort and bounded: a failure is one log line.
// ---------------------------------------------------------------------------

const DEFAULT_URL = "https://mcpemails.com/api/internal/webhook-disabled";

export function createDisabledNotifier(options: {
  secret: string | undefined;
  url?: string;
  fetch?: typeof fetch;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): (endpointId: string, workspaceId: string) => Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  return async (endpointId, workspaceId) => {
    if (!options.secret) {
      log("webhook_disabled_notify_skipped", { endpoint_id: endpointId, workspace_id: workspaceId, reason: "no_secret" });
      return;
    }
    try {
      const response = await doFetch(options.url || DEFAULT_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dispatch-secret": options.secret },
        body: JSON.stringify({ endpoint_id: endpointId }),
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) {
        log("webhook_disabled_notify_failed", { endpoint_id: endpointId, workspace_id: workspaceId, status: response.status });
      }
    } catch (error) {
      log("webhook_disabled_notify_failed", {
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        error_name: error instanceof Error ? error.name : "error",
      });
    }
  };
}
