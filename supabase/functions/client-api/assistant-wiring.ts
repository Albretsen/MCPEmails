// ---------------------------------------------------------------------------
// Builds `AssistantDeps` for one `/assistant/run` request.
//
// The assistant module (./assistant/) owns the model loop. This file owns what
// that loop is ALLOWED to do to a mailbox, and it enforces it here rather than
// trusting the loop or the model:
//
//   - tools: email_read (list / read / read_batch / search), email_organize
//     (move / move_batch / archive / flag), email_delete (delete /
//     delete_batch, trash only), folder_list, contact_search, draft_list.
//     Anything else is answered `isError: true` and never reaches an executor.
//   - NO SEND. No compose tool is on the list, and the key the assistant runs
//     with is NOT marked `firstPartyHuman`, so even a future mistake here
//     could not bypass a workspace's send-approval hold.
//   - `permanent: true` is refused on every delete.
//   - a viewer's assistant gets the read tools only.
//
// Tool calls made here are not charged to the action cap and write no
// `activity_log` rows; the run itself is metered by the assistant allowance.
// ---------------------------------------------------------------------------

import type { AssistantAllowance, AssistantDeps, Inbox, ToolRunResult, ToolSchema } from "./assistant-deps.ts";
import { ApiError } from "./errors.ts";
import { type MailEnv, type OpTimings, resultJson, resultText, runExecutor } from "./mail/run.ts";
import type { ApiKeyRow, McpSeam } from "./seam.ts";
import { type Store, toAssistantAllowance } from "./store.ts";

/** tool -> the actions the assistant may use (null: a single-purpose tool). */
export const ASSISTANT_TOOLS: Record<string, { actions: readonly string[] | null; write: boolean }> = {
  email_read: { actions: ["list", "read", "read_batch", "search"], write: false },
  email_organize: { actions: ["move", "move_batch", "archive", "flag"], write: true },
  email_delete: { actions: ["delete", "delete_batch"], write: true },
  folder_list: { actions: null, write: false },
  contact_search: { actions: null, write: false },
  draft_list: { actions: null, write: false },
};

/** Secrets the assistant module may read. Nothing of Supabase's, nothing of the mail layer's. */
const ENV_ALLOWED = /^(ASSISTANT_[A-Z0-9_]+|[A-Z0-9]+_API_KEY|[A-Z0-9]+_BASE_URL)$/;

function narrowActionEnum(schema: Record<string, unknown>, actions: readonly string[]): Record<string, unknown> {
  const properties = schema["properties"] as Record<string, unknown> | undefined;
  const action = properties?.["action"] as Record<string, unknown> | undefined;
  if (!properties || !action || !Array.isArray(action["enum"])) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      action: { ...action, enum: (action["enum"] as unknown[]).filter((a) => actions.includes(String(a))) },
    },
  };
}

export function assistantToolSchemas(mcp: McpSeam, canWrite: boolean): ToolSchema[] {
  const out: ToolSchema[] = [];
  for (const [name, rule] of Object.entries(ASSISTANT_TOOLS)) {
    if (rule.write && !canWrite) continue;
    const tool = mcp.TOOL_REGISTRY.find((t) => t.name === name);
    if (!tool) continue;
    out.push({
      name: tool.name,
      description: tool.description,
      inputSchema: rule.actions ? narrowActionEnum(tool.inputSchema, rule.actions) : tool.inputSchema,
    });
  }
  return out;
}

const refuse = (message: string): ToolRunResult => ({ result: { error: "not_allowed", message }, isError: true });

export function assistantToolRunner(
  mcp: McpSeam,
  env: MailEnv,
  assistantKey: ApiKeyRow,
  canWrite: boolean,
  timings: OpTimings,
): AssistantDeps["runTool"] {
  // One flow per run would make concurrent tool calls look like one operation
  // to the IMAP pool; each call gets its own.
  return async (name, rawArgs) => {
    const rule = Object.hasOwn(ASSISTANT_TOOLS, name) ? ASSISTANT_TOOLS[name] : undefined;
    if (!rule) return refuse(`The tool '${String(name).slice(0, 64)}' is not available to the assistant.`);
    if (rule.write && !canWrite) return refuse("This workspace role is read-only.");
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return refuse("Tool arguments must be an object.");
    }
    const args: Record<string, unknown> = { ...rawArgs };
    if (args["permanent"] === true) return refuse("Permanent deletion is not available to the assistant.");
    delete args["permanent"];
    // The ledger is the human client's; a model-chosen key must not reach it.
    delete args["idempotency_key"];

    const tool = mcp.TOOL_REGISTRY.find((t) => t.name === name);
    if (!tool) return refuse(`The tool '${name}' is not registered.`);

    let dispatchName = name;
    if (rule.actions) {
      const action = typeof args["action"] === "string" ? args["action"] : "";
      if (!rule.actions.includes(action)) {
        return refuse(`${name}: action must be one of ${rule.actions.join(", ")}.`);
      }
      const spec = mcp.CONSOLIDATED_SPECS[name]?.actions[action];
      if (!spec) return refuse(`${name}: unknown action.`);
      const errors = mcp.validateInputSchema(tool.inputSchema, args);
      if (errors.length > 0) {
        return {
          result: {
            error: "invalid_arguments",
            message: `${name}: invalid arguments.`,
            errors: errors.slice(0, 10),
          },
          isError: true,
        };
      }
      dispatchName = spec.legacy;
      // Same step handleToolsCall performs last: copy each exposed key onto
      // the name the per-action executor reads.
      for (const [legacyKey, exposedKey] of Object.entries(spec.renames ?? {})) {
        if (exposedKey in args) args[legacyKey] = args[exposedKey];
      }
    } else {
      const errors = mcp.validateInputSchema(tool.inputSchema, args);
      if (errors.length > 0) {
        return {
          result: { error: "invalid_arguments", message: `${name}: invalid arguments.`, errors: errors.slice(0, 10) },
          isError: true,
        };
      }
    }

    const inboxId = typeof args["inbox_id"] === "string" ? args["inbox_id"] : null;
    try {
      const outcome = await runExecutor(env, { tool: dispatchName, args }, {
        inboxId,
        flow: {},
        timings,
        apiKey: assistantKey,
      });
      const isError = outcome.logStatus !== "success" ||
        (outcome.result as { isError?: boolean } | null)?.isError === true;
      return isError
        ? { result: { error: outcome.logErrorCode ?? "error", message: resultText(outcome.result) }, isError: true }
        : { result: resultJson(outcome.result), isError: false };
    } catch (error) {
      const body = error instanceof ApiError
        ? error.body
        : { code: "provider_error", message: "The mail provider request failed." };
      return { result: { error: body.code, message: body.message }, isError: true };
    }
  };
}

/** Values safe to put on a log line: numbers, booleans, short strings. */
function scrubLogFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === null || typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string") out[key] = value.length <= 120 ? value : `[${value.length} chars]`;
    else out[key] = "[omitted]";
  }
  return out;
}

export function buildAssistantDeps(input: {
  mcp: McpSeam;
  store: Store;
  mailEnv: MailEnv;
  /** The hidden key WITHOUT the human-sender marker. */
  assistantKey: ApiKeyRow;
  canWrite: boolean;
  user: { id: string; email: string };
  workspaceId: string;
  inboxes: Inbox[];
  fallbackAllowance: AssistantAllowance;
  env: (name: string) => string | undefined;
  log: (event: string, fields: Record<string, unknown>) => void;
  timings: OpTimings;
}): AssistantDeps {
  return {
    user: input.user,
    workspaceId: input.workspaceId,
    inboxes: input.inboxes,
    toolSchemas: assistantToolSchemas(input.mcp, input.canWrite),
    runTool: assistantToolRunner(input.mcp, input.mailEnv, input.assistantKey, input.canWrite, input.timings),
    async reserveAllowance() {
      const row = await input.store.reserveRun(input.workspaceId, input.user.id);
      if (!row) return { ok: false, allowance: input.fallbackAllowance };
      const allowance = toAssistantAllowance(row);
      return row.allowed && row.reservation_id
        ? { ok: true, reservationId: row.reservation_id, allowance }
        : { ok: false, allowance };
    },
    async finalizeAllowance(reservationId, usage) {
      await input.store.finalizeRun(reservationId, usage);
    },
    env: (name) => (ENV_ALLOWED.test(name) ? input.env(name) : undefined),
    log: (event, fields) => input.log(`assistant.${event}`, scrubLogFields(fields)),
  };
}
