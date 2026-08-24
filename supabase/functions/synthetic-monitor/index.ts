import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PUBLIC_MCP_ENDPOINT = Deno.env.get("SYNTHETIC_MCP_ENDPOINT") ?? "https://mcpemails.com/api/mcp";
// The IMAP-connected mailbox the health-check steps (initialize/tools_list/
// inbox_list/email_read) exercise -- this is the thing actually being
// monitored and must keep running against hello@mcpemails.com unchanged.
const ALERT_RECIPIENT = "hello@mcpemails.com";
// Where alert/recovery notification emails are sent FROM and TO. Migadu
// (hello@mcpemails.com's SMTP provider) has a measured ~5.6% intermittent
// send failure rate, so outbound alerting uses a Gmail-connected inbox
// instead, which sends via the Gmail API rather than the flaky raw SMTP
// client. Self-send: FROM and TO are both this address.
const ALERT_EMAIL = "bjellanda@gmail.com";
// IMAP/SMTP delivery occasionally takes longer than the read-only MCP calls.
// Keep the synthetic request alive long enough to receive the definitive MCP
// result rather than classifying a completed delivery as a timeout.
const REQUEST_TIMEOUT_MS = 30_000;

type Mode = "read";
type StepName = "initialize" | "tools_list" | "inbox_list" | "email_read" | "internal";
type FailureClass = "public_endpoint" | "authentication" | "mcp_protocol" | "database" | "provider_read" | "internal";
type StepResult = { name: StepName; status: "succeeded" | "failed"; duration_ms: number; error_code?: string };
type Incident = { id: string; fingerprint: string; should_alert?: boolean; should_recover?: boolean };
type McpResponse = { result?: { isError?: boolean; structuredContent?: { inboxes?: Array<{ inbox_id?: unknown; email_address?: unknown }> } }; error?: { code?: unknown; data?: unknown } };

// Codes raised by callMcp when no MCP response ever came back. These describe
// the transport, not the server's behaviour, so they classify as
// `public_endpoint`, which is deliberately absent from the immediate-alert list
// in record_synthetic_monitor_failure and therefore needs two consecutive
// failures before it pages. A single hung request is not an incident.
const TRANSPORT_FAILURE_CODES = new Set(["public_endpoint", "request_timeout", "endpoint_unreachable"]);

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : "unexpected_response";
}

function mcpFailureCode(body: McpResponse | null): string {
  if (body?.error?.code === -32602) {
    // JSON-schema paths are controlled field names, not request values.
    const rawData = body.error.data as { errors?: Array<{ path?: unknown }> } | Array<{ path?: unknown }> | undefined;
    const errors = Array.isArray(rawData) ? rawData : rawData?.errors;
    const path = Array.isArray(errors) && typeof errors[0]?.path === "string" ? errors[0].path : "";
    if (path.endsWith(".inbox_id")) return "invalid_inbox_id";
    if (path.endsWith(".idempotency_key")) return "invalid_idempotency_key";
    if (path === "arguments.to" || path.startsWith("arguments.to[")) return "invalid_recipient_shape";
    return "invalid_tool_arguments";
  }
  return safeCode(body?.error?.code);
}

async function callMcp(apiKey: string, id: number, method: string, params?: Record<string, unknown>) {
  let response: Response;
  try {
    response = await fetch(PUBLIC_MCP_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // AbortSignal.timeout rejects with a TimeoutError whose message ("Signal
    // timed out.") fails safeCode's charset and used to degrade to the generic
    // `unexpected_response`, which then classified as `mcp_protocol` and paged
    // on the first strike. Read `name` structurally: DOMException does not
    // reliably sit on Error's prototype chain across runtimes.
    const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
    throw new Error(name === "TimeoutError" ? "request_timeout" : "endpoint_unreachable");
  }
  const body = await response.json().catch(() => null) as McpResponse | null;
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "authentication" : "public_endpoint");
  if (!body || body.error || body.result?.isError) throw new Error(mcpFailureCode(body));
  return body;
}

function findInboxId(response: McpResponse, emailAddress: string): string | null {
  const inbox = response.result?.structuredContent?.inboxes?.find((candidate) => candidate.email_address === emailAddress);
  return typeof inbox?.inbox_id === "string" && /^[0-9a-f-]{36}$/i.test(inbox.inbox_id) ? inbox.inbox_id : null;
}

// Sends monitor alert/recovery emails via the Gmail-connected bjellanda@gmail.com
// inbox using its own minimally-scoped NOTIFY_MCP_API_KEY, independent of the
// SYNTHETIC_MCP_API_KEY used above for the hello@mcpemails.com health checks.
// A missing notify key fails closed here (logs + no-ops) rather than throwing,
// so a misconfigured alert path can never take down the health-check run above it.
async function sendMonitorEmail(id: number, subject: string, body: string, idempotencyKey: string) {
  const notifyApiKey = Deno.env.get("NOTIFY_MCP_API_KEY");
  if (!notifyApiKey) {
    console.error("NOTIFY_MCP_API_KEY not configured; skipping synthetic monitor alert email");
    return;
  }
  const resolvedInboxId = findInboxId(await callMcp(notifyApiKey, id, "tools/call", { name: "inbox_list", arguments: {} }), ALERT_EMAIL);
  if (!resolvedInboxId) throw new Error("monitor_inbox_not_found");
  await callMcp(notifyApiKey, id, "tools/call", {
    // The public v112 MCP surface consolidates outbound operations under
    // email_compose; action: send dispatches to the server's email_send handler.
    name: "email_compose",
    arguments: { action: "send", inbox_id: resolvedInboxId, to: [ALERT_EMAIL], subject, body, idempotency_key: idempotencyKey },
  });
}

Deno.serve(async (request) => {
  const expectedToken = Deno.env.get("SYNTHETIC_MONITOR_TOKEN");
  if (!expectedToken || request.headers.get("x-synthetic-monitor-token") !== expectedToken) return json(401, { error: "unauthorized" });

  const input = await request.json().catch(() => ({})) as { controlled_failure?: boolean };
  const mode: Mode = "read";
  const controlledFailure = input.controlled_failure === true;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(503, { error: "monitor_not_configured" });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const started = Date.now();
  const { data: created, error: createError } = await supabase.from("synthetic_monitor_runs").insert({ mode }).select("id").single();
  if (createError || !created) return json(500, { error: "run_create_failed" });

  const apiKey = Deno.env.get("SYNTHETIC_MCP_API_KEY");
  const steps: StepResult[] = [];
  let failureClass: FailureClass | null = null;
  let failedStep: StepName | null = null;
  const fail = (failure: FailureClass, step: StepName, code: string) => {
    failureClass = failure;
    failedStep = step;
    steps.push({ name: step, status: "failed", duration_ms: 0, error_code: safeCode(code) });
  };
  const runStep = async (name: Exclude<StepName, "internal">, method: string, params?: Record<string, unknown>): Promise<McpResponse | null> => {
    const stepStarted = Date.now();
    try {
      const result = await callMcp(apiKey!, steps.length + 1, method, params);
      steps.push({ name, status: "succeeded", duration_ms: Date.now() - stepStarted });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : "internal";
      // Transport codes win over the per-step default: a request that never
      // returned proves nothing about the MCP layer or the provider, and the
      // step name is still carried in the fingerprint for diagnosis.
      failureClass = code === "authentication"
        ? "authentication"
        : TRANSPORT_FAILURE_CODES.has(code)
          ? "public_endpoint"
          : name === "email_read"
            ? "provider_read"
            : "mcp_protocol";
      failedStep = name;
      steps.push({ name, status: "failed", duration_ms: Date.now() - stepStarted, error_code: safeCode(code) });
      return null;
    }
  };

  if (controlledFailure) fail("internal", "internal", "controlled_failure");
  else if (!apiKey) fail("internal", "internal", "monitor_not_configured");
  else {
    await runStep("initialize", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpemails-synthetic-monitor", version: "1.0" } });
    if (!failureClass) await runStep("tools_list", "tools/list");
    const inboxes = !failureClass ? await runStep("inbox_list", "tools/call", { name: "inbox_list", arguments: {} }) : null;
    const dedicatedInboxId = inboxes ? findInboxId(inboxes, ALERT_RECIPIENT) : null;
    if (!failureClass && !dedicatedInboxId) fail("mcp_protocol", "inbox_list", "monitor_inbox_not_found");
    if (!failureClass) await runStep("email_read", "tools/call", { name: "email_read", arguments: { action: "list", limit: 1 } });
  }

  const duration_ms = Date.now() - started;
  const status = failureClass ? "failed" : "succeeded";
  const fingerprint = failureClass ? `${failureClass}:${failedStep}` : null;
  const { error: finishError } = await supabase.from("synthetic_monitor_runs").update({ status, failure_class: failureClass, failed_step: failedStep, failure_fingerprint: fingerprint, steps, completed_at: new Date().toISOString(), duration_ms }).eq("id", created.id);
  if (finishError) return json(500, { error: "run_finish_failed", run_id: created.id });

  if (failureClass && failedStep && fingerprint) {
    const { data: incident, error: incidentError } = await supabase.rpc("record_synthetic_monitor_failure", { p_run_id: created.id, p_failure_class: failureClass, p_failed_step: failedStep, p_fingerprint: fingerprint }).single<Incident>();
    if (incidentError || !incident) return json(500, { error: "incident_record_failed", run_id: created.id });
    if (incident.should_alert && apiKey) {
      try {
        await sendMonitorEmail(100, `MCPEmails synthetic monitor alert: ${incident.fingerprint}`, "A production synthetic monitor incident is open. The monitor will send one recovery notice after the first successful check.", `synthetic-incident-${incident.id}`);
        await supabase.rpc("mark_synthetic_monitor_incident_alerted", { p_incident_id: incident.id });
      } catch (error) {
        // Leave notification unmarked so a later equivalent failure retries it,
        // but never silently: an alert path that is failing every cycle is
        // otherwise invisible. Sanitized code only, per the monitoring contract.
        console.error(JSON.stringify({ event: "synthetic_monitor_incident_alert_failed", incident_id: incident.id, error_code: safeCode(error instanceof Error ? error.message : null) }));
      }
    }
    return json(503, { run_id: created.id, status, failed_step: failedStep });
  }

  const { data: recoveries, error: recoveryError } = await supabase.rpc("resolve_synthetic_monitor_incidents", { p_run_id: created.id }).returns<Incident[]>();
  if (recoveryError) return json(500, { error: "incident_resolution_failed", run_id: created.id });
  const recoveryRows: Incident[] = Array.isArray(recoveries) ? recoveries : [];
  if (apiKey) for (const incident of recoveryRows) {
    if (!incident.should_recover) continue;
    try {
      await sendMonitorEmail(200, `MCPEmails synthetic monitor recovery: ${incident.fingerprint}`, "The production synthetic monitor completed successfully after the open incident.", `synthetic-recovery-${incident.id}`);
      await supabase.rpc("mark_synthetic_monitor_recovery_alerted", { p_incident_id: incident.id });
    } catch (error) {
      // The incident is resolved; the notification stays eligible for a later
      // successful run. Log the sanitized code so a persistently broken
      // recovery path surfaces instead of just arriving a cycle late.
      console.error(JSON.stringify({ event: "synthetic_monitor_recovery_alert_failed", incident_id: incident.id, error_code: safeCode(error instanceof Error ? error.message : null) }));
    }
  }
  return json(200, { run_id: created.id, status });
});
