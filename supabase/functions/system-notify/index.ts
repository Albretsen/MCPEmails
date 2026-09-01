import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const PUBLIC_MCP_ENDPOINT = Deno.env.get("SYSTEM_NOTIFY_MCP_ENDPOINT") ?? "https://mcpemails.com/api/mcp";
// The connected/authenticated inbox we send FROM (must be a real inbox_list entry with credentials).
// Self-send, so this matches NOTIFY_TO_EMAIL below. It was an OAuth Gmail API
// connection until 2026-09-01 and is now Gmail over IMAP with an app password;
// the send path is whatever that inbox is connected as on the day, which is
// exactly the assumption resolveThreadAnchor exists to stop this file making.
const SEND_FROM_INBOX_EMAIL = "bjellanda@gmail.com";
// Where the notification is delivered TO.
const NOTIFY_TO_EMAIL = "bjellanda@gmail.com";
const REQUEST_TIMEOUT_MS = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventBody = { event_id?: unknown; event_type?: unknown; payload?: unknown };
type McpResponse = {
  result?: {
    isError?: boolean;
    structuredContent?: {
      inboxes?: Array<{ inbox_id?: unknown; email_address?: unknown }>;
      message_id?: unknown;
      messages?: Array<{ id?: unknown }>;
    };
    // The MCP server reports a monthly action-cap rejection as an isError tool
    // result carrying this namespaced block, not as a JSON-RPC error. Named
    // here so an alert that dies because the notifier's own workspace ran out
    // of actions says so, instead of collapsing into "mcp_protocol".
    _meta?: { "com.mcpemails/usage_limit"?: { error_code?: unknown } };
  };
  error?: { code?: unknown; data?: unknown };
};
type Template = { subject: string; body: string };

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Best-effort growth snapshot for the user.signup notification. Every query is
// independently guarded so a single failed count doesn't sink the whole email;
// callers see `null` for anything that couldn't be computed and render it as
// "unknown" rather than throwing.
type GrowthStats = {
  totalUsers: number | null;
  last24h: number | null;
  last7d: number | null;
  recentWorkspaces: number | null;
  recentWorkspacesConnected: number | null;
};

async function fetchGrowthStats(supabase: SupabaseClient): Promise<GrowthStats> {
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  // PromiseLike, not Promise: a PostgREST builder is thenable but not a Promise.
  const count = async (query: PromiseLike<{ count: number | null; error: unknown }>) => {
    try {
      const { count: value, error } = await query;
      return error ? null : value;
    } catch {
      return null;
    }
  };

  const [totalUsers, last24h, last7d] = await Promise.all([
    count(supabase.from("users").select("*", { count: "exact", head: true })),
    count(supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", since24h)),
    count(supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", since7d)),
  ]);

  // Of the workspaces created in the last 7 days, how many have connected an
  // inbox yet -- a cheap read of the existing analytics_first_inbox_connected_at
  // column on workspaces, no join required.
  //
  // Both numbers are exact head counts rather than data.length over a fetched
  // page: PostgREST caps a row-returning select at db-max-rows (1000) with no
  // error, so counting the rows we were handed would quietly flatten out at
  // 1000 once a week's signups got that far, and the connected ratio with it.
  const [recentWorkspaces, recentWorkspacesConnected] = await Promise.all([
    count(
      supabase.from("workspaces").select("*", { count: "exact", head: true })
        .gte("created_at", since7d).is("deleted_at", null),
    ),
    count(
      supabase.from("workspaces").select("*", { count: "exact", head: true })
        .gte("created_at", since7d).is("deleted_at", null)
        .not("analytics_first_inbox_connected_at", "is", null),
    ),
  ]);

  return { totalUsers, last24h, last7d, recentWorkspaces, recentWorkspacesConnected };
}

// Everything the automation.auto_disabled email needs beyond the event payload
// itself. Same guarded style as fetchGrowthStats: any single lookup may come
// back null, and the email renders "unknown" rather than failing to send. The
// owner's email address is read HERE, at send time, and deliberately never
// written into system_events.payload, which the migration reserves for
// structured metadata only.
type AutomationContext = {
  ownerEmail: string | null;
  workspaceName: string | null;
  rulesEnabled: number | null;
  rulesAutoDisabled: number | null;
};

async function fetchAutomationContext(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AutomationContext> {
  const out: AutomationContext = {
    ownerEmail: null,
    workspaceName: null,
    rulesEnabled: null,
    rulesAutoDisabled: null,
  };
  if (!UUID_RE.test(workspaceId)) return out;

  try {
    const { data } = await supabase
      .from("workspaces")
      .select("display_name, owner_id")
      .eq("id", workspaceId)
      .maybeSingle();
    if (data) {
      out.workspaceName = typeof data.display_name === "string" ? data.display_name : null;
      if (typeof data.owner_id === "string") {
        const { data: owner } = await supabase
          .from("users")
          .select("email")
          .eq("id", data.owner_id)
          .maybeSingle();
        if (owner && typeof owner.email === "string") out.ownerEmail = owner.email;
      }
    }
  } catch { /* best-effort: the alert is worth sending without it */ }

  // Exact head counts, never data.length: a row-returning select silently
  // truncates at 1000, so counting fetched rows would understate a workspace
  // with a lot of rules. Same trap fetchGrowthStats documents.
  const count = async (query: PromiseLike<{ count: number | null; error: unknown }>) => {
    try {
      const { count: value, error } = await query;
      return error ? null : value;
    } catch {
      return null;
    }
  };
  const [enabled, autoDisabled] = await Promise.all([
    count(
      supabase.from("triage_rules").select("*", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).eq("enabled", true).is("deleted_at", null),
    ),
    count(
      supabase.from("triage_rules").select("*", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).eq("enabled", false).is("deleted_at", null)
        .not("disabled_reason", "is", null),
    ),
  ]);
  out.rulesEnabled = enabled;
  out.rulesAutoDisabled = autoDisabled;
  return out;
}

// What each automation failure code means for the person who has to act on it.
// Kept short and specific: the point of this alert is that somebody reads it
// once and knows whether to reconnect a client, fix a mailbox, or look at us.
const AUTOMATION_ERROR_GUIDANCE: Record<string, string> = {
  api_key_expired:
    "The OAuth connection behind the rule is gone (disconnected, or the refresh chain aged out). "
    + "The user has to reconnect MCP Emails in their MCP client and switch the rule back on. "
    + "NOTE: a merely stale access token no longer produces this - the runner follows key rotation.",
  api_key_unavailable: "The key was revoked or deleted. The rule cannot run until it is pointed at a live key.",
  scope_denied: "The key no longer holds the scope the rule's action needs.",
  inbox_not_permitted: "The key's inbox allowlist no longer includes the rule's inbox.",
  inbox_unavailable: "The inbox the rule targets is gone.",
  search_failed: "The mailbox search failed repeatedly. Likely a provider or credential problem on that inbox.",
  folder_unresolved: "The destination folder could not be resolved on the provider.",
  invalid_filter: "The stored filter no longer validates. This is ours, not the user's.",
  invalid_action: "The stored action no longer validates. This is ours, not the user's.",
};

// Only "user.signup" is wired up for now; new event types just need a new
// entry here -- an event_type with no matching entry is a no-op, not a
// transport failure (see the unmatched-template branch below). buildTemplate
// is async and receives the service-role supabase client so entries can pull
// live stats at send-time instead of trusting the trigger's payload.
async function buildTemplate(eventType: string, payload: Record<string, unknown>, supabase: SupabaseClient): Promise<Template | null> {
  if (eventType === "user.signup") {
    const email = typeof payload.email === "string" ? payload.email : "unknown";
    const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : "unknown";
    const stats = await fetchGrowthStats(supabase);

    const fmt = (n: number | null) => (n === null ? "unknown" : String(n));
    const plural = (n: number | null, word: string) => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

    const activation =
      stats.recentWorkspaces === null || stats.recentWorkspacesConnected === null
        ? "unknown"
        : `${stats.recentWorkspacesConnected} of ${stats.recentWorkspaces}`;

    const subject =
      stats.totalUsers === null
        ? `New signup: ${email}`
        : `New signup - you're at ${stats.totalUsers} users now`;

    const body = [
      `Nice, another one. ${email} just signed up.`,
      "",
      "THE HEADLINE",
      stats.totalUsers === null ? "Total users: unknown" : `You're now at ${stats.totalUsers} users total.`,
      "",
      "MOMENTUM",
      `Last 24 hours: ${plural(stats.last24h, "new signup")}`,
      `Last 7 days: ${plural(stats.last7d, "new signup")}`,
      "",
      "ACTIVATION",
      `New workspaces (last 7 days) with an inbox connected: ${activation}`,
      "",
      "DETAILS",
      `email: ${email}`,
      `workspace_id: ${workspaceId}`,
      `signed up: ${new Date().toISOString()}`,
      "",
      "Full picture: https://mcpemails.com/admin/growth",
    ].join("\n");

    return { subject, body };
  }

  if (eventType === "automation.auto_disabled") {
    // An automation switched itself off after repeated failures. This is the
    // alert that did not exist when one customer's rules failed 134 times over
    // four days with nobody told, so it is written to be read once and acted on.
    const ruleId = typeof payload.rule_id === "string" ? payload.rule_id : "unknown";
    const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : "";
    const inboxId = typeof payload.inbox_id === "string" ? payload.inbox_id : "unknown";
    const ruleName = typeof payload.rule_name === "string" && payload.rule_name ? payload.rule_name : "(unnamed)";
    const errorCode = typeof payload.error_code === "string" ? payload.error_code : "unknown";
    const failures = typeof payload.consecutive_failures === "number" ? payload.consecutive_failures : null;
    const context = await fetchAutomationContext(supabase, workspaceId);

    const who = context.ownerEmail ?? context.workspaceName ?? workspaceId ?? "unknown workspace";
    const subject = `Automation switched itself off: ${who}`;
    const body = [
      `An automation stopped itself after ${failures === null ? "repeated" : failures} consecutive failed runs.`,
      "",
      "WHO",
      `owner: ${context.ownerEmail ?? "unknown"}`,
      `workspace: ${context.workspaceName ?? "unknown"} (${workspaceId || "unknown"})`,
      "",
      "WHAT STOPPED",
      `rule: ${ruleName}`,
      `rule_id: ${ruleId}`,
      `inbox_id: ${inboxId}`,
      `error_code: ${errorCode}`,
      "",
      "WHAT IT MEANS",
      AUTOMATION_ERROR_GUIDANCE[errorCode] ?? "No specific guidance for this code. Read the rule's run log.",
      "",
      "REST OF THE WORKSPACE",
      `automations still switched on: ${context.rulesEnabled === null ? "unknown" : context.rulesEnabled}`,
      `automations already switched off by failures: ${context.rulesAutoDisabled === null ? "unknown" : context.rulesAutoDisabled}`,
      "",
      `disabled at: ${new Date().toISOString()}`,
    ].join("\n");

    return { subject, body };
  }
  return null;
}

async function callMcp(apiKey: string, id: number, method: string, params?: Record<string, unknown>) {
  const response = await fetch(PUBLIC_MCP_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null) as McpResponse | null;
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "authentication" : "public_endpoint");
  if (!body) throw new Error("mcp_protocol");
  if (body.result?._meta?.["com.mcpemails/usage_limit"]?.error_code === "usage_limit_reached") {
    throw new Error("usage_limit_reached");
  }
  if (body.error || body.result?.isError) throw new Error("mcp_protocol");
  return body;
}

function sendFromInboxId(response: McpResponse): string | null {
  const inbox = response.result?.structuredContent?.inboxes?.find((candidate) => candidate.email_address === SEND_FROM_INBOX_EMAIL);
  return typeof inbox?.inbox_id === "string" && /^[0-9a-f-]{36}$/i.test(inbox.inbox_id) ? inbox.inbox_id : null;
}

// One row per event_type, holding the message_id of the most recent
// notification sent for that event_type -- see the system_notify_threads
// migration for details. Absence of a row (or a lookup failure) just means
// "start a fresh thread", never a hard error.
async function getThreadMessageId(supabase: SupabaseClient, eventType: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("system_notify_threads")
      .select("message_id")
      .eq("event_type", eventType)
      .maybeSingle();
    if (error || !data) return null;
    return typeof data.message_id === "string" ? data.message_id : null;
  } catch {
    return null;
  }
}

async function saveThreadMessageId(supabase: SupabaseClient, eventType: string, messageId: string): Promise<void> {
  await supabase
    .from("system_notify_threads")
    .upsert({ event_type: eventType, message_id: messageId, updated_at: new Date().toISOString() }, { onConflict: "event_type" });
}

function extractMessageId(response: McpResponse): string | null {
  const messageId = response.result?.structuredContent?.message_id;
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

/**
 * Turn a stored thread anchor into an id `email_compose` action 'reply' can
 * actually address.
 *
 * The two providers this notifier has run on hand back different things from a
 * send. The Gmail API returns its own message id, which every other tool
 * accepts, so threading worked for as long as the notify inbox was an OAuth
 * Gmail connection. An IMAP inbox returns the RFC 5322 Message-ID it minted for
 * the outgoing MIME header ("<uuid@mcpemails.com>"), but every IMAP tool
 * addresses a message as "<folder>:<uid>". Replying with the header value makes
 * the uid parse as NaN, so the reply fails message_not_found before it opens a
 * socket, sendSystemEmail falls back to a fresh send, and the fallback then
 * stores another unaddressable id -- which is why the signup mails stopped
 * threading the moment bjellanda@gmail.com was reconnected over IMAP with an
 * app password on 2026-09-01, and why they could never recover on their own.
 *
 * An anchor in angle brackets is a Message-ID header, never a provider id, so
 * that shape alone decides whether a lookup is needed. A Gmail API id is
 * returned untouched and costs nothing. Everything else is resolved with one
 * HEADER search, which IMAP SEARCH supports natively and email_search passes
 * through verbatim via its raw `query` escape hatch.
 *
 * The lookup deliberately happens HERE, when the NEXT notification is being
 * sent, rather than straight after the send that produced the id: by then the
 * message has long since been delivered, so there is no race with the provider
 * still filing it. Search with no include_folders covers INBOX, which is where
 * this notification lands because it is addressed to the inbox that sends it.
 *
 * Returns null when the anchor cannot be resolved, which the caller already
 * treats as "start a fresh thread".
 */
async function resolveThreadAnchor(
  apiKey: string,
  inboxId: string,
  anchor: string,
): Promise<string | null> {
  if (!(anchor.startsWith("<") && anchor.endsWith(">"))) return anchor;
  try {
    const found = await callMcp(apiKey, 4, "tools/call", {
      name: "email_read",
      arguments: {
        action: "search",
        inbox_id: inboxId,
        query: `HEADER Message-ID "${anchor}"`,
        limit: 1,
      },
    });
    const id = found.result?.structuredContent?.messages?.[0]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch (error) {
    console.warn(
      "resolveThreadAnchor: could not resolve the stored anchor to a provider id",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// Replies into the thread anchored by `replyToMessageId` when one is given
// (subject/threading headers are derived server-side from that message), and
// falls back to a brand-new "send" -- with the caller-supplied subject -- if
// there's no prior thread yet, or if the reply attempt fails (e.g. the
// anchor message was since deleted or moved). Returns the message_id of
// whichever email actually went out, so the caller can persist it as the
// new thread anchor. Reply and send use distinct idempotency keys since
// they're different operations with different arguments -- reusing one key
// across both would trip the "reused with different arguments" conflict
// check on the fallback attempt.
async function sendSystemEmail(
  apiKey: string,
  subject: string,
  body: string,
  idempotencyKey: string,
  to: string,
  replyToMessageId: string | null,
): Promise<string> {
  const inboxes = await callMcp(apiKey, 1, "tools/call", { name: "inbox_list", arguments: {} });
  const inboxId = sendFromInboxId(inboxes);
  if (!inboxId) throw new Error("notify_inbox_not_found");

  const replyAnchor = replyToMessageId
    ? await resolveThreadAnchor(apiKey, inboxId, replyToMessageId)
    : null;

  if (replyAnchor) {
    try {
      const replyResponse = await callMcp(apiKey, 2, "tools/call", {
        name: "email_compose",
        arguments: {
          action: "reply",
          inbox_id: inboxId,
          message_id: replyAnchor,
          body,
          idempotency_key: `${idempotencyKey}-reply`,
        },
      });
      const messageId = extractMessageId(replyResponse);
      if (messageId) return messageId;
    } catch (error) {
      console.warn(
        "sendSystemEmail: reply into existing thread failed, falling back to a new email",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const sendResponse = await callMcp(apiKey, 3, "tools/call", {
    name: "email_compose",
    arguments: { action: "send", inbox_id: inboxId, to: [to], subject, body, idempotency_key: `${idempotencyKey}-send` },
  });
  const messageId = extractMessageId(sendResponse);
  if (!messageId) throw new Error("missing_message_id");
  return messageId;
}

Deno.serve(async (request) => {
  const expectedToken = Deno.env.get("SYSTEM_NOTIFY_TOKEN");
  if (!expectedToken || request.headers.get("x-system-notify-token") !== expectedToken) return json(401, { error: "unauthorized" });

  const input = await request.json().catch(() => null) as EventBody | null;
  const eventId = typeof input?.event_id === "string" ? input.event_id : "";
  const eventType = typeof input?.event_type === "string" ? input.event_type : "";
  const payload = (input?.payload && typeof input.payload === "object" ? input.payload : {}) as Record<string, unknown>;
  if (!UUID_RE.test(eventId) || eventType.length === 0) return json(400, { error: "invalid_event" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(503, { error: "notify_not_configured" });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const markProcessed = async (status: "sent" | "failed", error: string | null) => {
    await supabase.from("system_events").update({ status, error, processed_at: new Date().toISOString() }).eq("id", eventId);
  };

  try {
    const template = await buildTemplate(eventType, payload, supabase);
    if (!template) {
      await markProcessed("failed", "unknown_event_type");
      return json(200, { event_id: eventId, status: "failed" });
    }

    const apiKey = Deno.env.get("NOTIFY_MCP_API_KEY");
    if (!apiKey) {
      await markProcessed("failed", "notify_not_configured");
      return json(200, { event_id: eventId, status: "failed" });
    }

    try {
      const replyToMessageId = await getThreadMessageId(supabase, eventType);
      const sentMessageId = await sendSystemEmail(
        apiKey,
        template.subject,
        template.body,
        `system-event-${eventId}`,
        NOTIFY_TO_EMAIL,
        replyToMessageId,
      );
      await saveThreadMessageId(supabase, eventType, sentMessageId);
      await markProcessed("sent", null);
      return json(200, { event_id: eventId, status: "sent" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "send_failed";
      await markProcessed("failed", message);
      return json(200, { event_id: eventId, status: "failed" });
    }
  } catch (error) {
    try {
      await markProcessed("failed", "internal_error");
    } catch { /* best-effort; the row may already reflect an earlier attempt */ }
    return json(500, { error: "internal_error", event_id: eventId, message: error instanceof Error ? error.message : String(error) });
  }
});
