/* What the assistant may do to a mailbox, enforced on the server.
 *
 * The model is never trusted to stay inside these rules: every tool call it
 * produces goes through `sanitizeToolCall`, which REBUILDS the arguments from
 * an allow-list of keys per action. Anything not listed here cannot reach
 * `runTool`, whatever the model (or an email it read) asks for:
 *
 *   email_read      list | read | read_batch | search        (never HTML, never attachments)
 *   email_organize  move | move_batch | archive | flag
 *   email_delete    delete | delete_batch                     (always `permanent: false`)
 *   folder_list, contact_search, draft_list
 *
 * Not reachable: sending, replying, forwarding, permanent delete, copy,
 * search_and_move, search_and_delete, attachments, raw originals, folder
 * create/rename/delete, drafts written to the mailbox, schedules, automations,
 * signatures. `inbox_id` must be one of the caller's inboxes.
 */

import type { LlmToolDef } from "./llm/types.ts";

export interface Limits {
  maxRounds: number;
  wallClockMs: number;
  /** Used when the allowance does not carry `max_tokens_per_run`. */
  defaultTokenCeiling: number;
  maxOutputTokensPerRound: number;
  maxToolCallsPerRound: number;
  /** Characters of one email body handed to the model. */
  bodyMaxChars: number;
  batchBodyMaxChars: number;
  readBatchMax: number;
  listLimitMax: number;
  listLimitDefault: number;
  /** Message ids in one move / flag / delete call. */
  mutateBatchMax: number;
  /** Email bodies read in one run. */
  maxBodiesPerRun: number;
  /** Messages changed in one run. */
  maxMutatedPerRun: number;
  draftBodyMaxChars: number;
  /** How long an edit's diff stays on screen before the final text replaces it. */
  editHoldMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRounds: 12,
  wallClockMs: 120_000,
  defaultTokenCeiling: 60_000,
  maxOutputTokensPerRound: 3_000,
  maxToolCallsPerRound: 8,
  bodyMaxChars: 6_000,
  batchBodyMaxChars: 2_500,
  readBatchMax: 10,
  listLimitMax: 25,
  listLimitDefault: 15,
  mutateBatchMax: 50,
  maxBodiesPerRun: 20,
  maxMutatedPerRun: 200,
  draftBodyMaxChars: 20_000,
  editHoldMs: 600,
};

export type RealToolName =
  | "email_read"
  | "email_organize"
  | "email_delete"
  | "folder_list"
  | "contact_search"
  | "draft_list";

export type VirtualToolName = "write_draft" | "edit_draft" | "request_send";

export const REAL_TOOLS: readonly RealToolName[] = [
  "email_read",
  "email_organize",
  "email_delete",
  "folder_list",
  "contact_search",
  "draft_list",
];
export const VIRTUAL_TOOLS: readonly VirtualToolName[] = ["write_draft", "edit_draft", "request_send"];

const ACTIONS: Record<RealToolName, readonly string[]> = {
  email_read: ["list", "read", "read_batch", "search"],
  email_organize: ["move", "move_batch", "archive", "flag"],
  email_delete: ["delete", "delete_batch"],
  folder_list: [],
  contact_search: [],
  draft_list: [],
};

const FLAG_ACTIONS = ["read", "unread", "flag", "unflag"] as const;
export type FlagAction = (typeof FLAG_ACTIONS)[number];

export function isRealTool(name: string): name is RealToolName {
  return (REAL_TOOLS as readonly string[]).includes(name);
}
export function isVirtualTool(name: string): name is VirtualToolName {
  return (VIRTUAL_TOOLS as readonly string[]).includes(name);
}

export type RejectCode =
  | "tool_not_allowed"
  | "action_not_allowed"
  | "invalid_arguments"
  | "inbox_not_allowed"
  | "batch_too_large"
  | "read_budget_exhausted"
  | "mutation_budget_exhausted";

export interface SanitizedCall {
  ok: true;
  tool: RealToolName;
  /** "" for tools without actions. */
  action: string;
  /** Rebuilt from the allow-list. This, and only this, is passed to runTool. */
  args: Record<string, unknown>;
  /** null only for contact_search across all inboxes. */
  inboxId: string | null;
  readOnly: boolean;
  /** The message ids the call names (reads and mutations). */
  messageIds: string[];
  /** `archive` with several ids runs as one archive call per id. */
  fanOut: boolean;
}

export interface RejectedCall {
  ok: false;
  code: RejectCode;
  /** Shown to the model, never to the user. No mail content. */
  message: string;
}

export interface PolicyContext {
  inboxIds: ReadonlySet<string>;
  /** Used when the model omits inbox_id and the choice is unambiguous. */
  defaultInboxId: string | null;
  limits: Limits;
  /** Bodies already read / messages already changed in this run. */
  bodiesRead: number;
  mutated: number;
}

const MAX_ID_CHARS = 1_024;

export function sanitizeToolCall(name: string, rawArgs: unknown, ctx: PolicyContext): SanitizedCall | RejectedCall {
  if (!isRealTool(name)) return reject("tool_not_allowed", `Tool "${clip(name, 40)}" is not available.`);
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return reject("invalid_arguments", "Arguments must be a JSON object.");
  }
  const a = rawArgs as Record<string, unknown>;
  const L = ctx.limits;

  const allowed = ACTIONS[name];
  let action = "";
  if (allowed.length) {
    if (typeof a.action !== "string" || !allowed.includes(a.action)) {
      return reject("action_not_allowed", `Action must be one of: ${allowed.join(", ")}. Nothing else is available.`);
    }
    action = a.action;
  }

  // Inbox: must be one of the caller's own. Never taken on trust.
  let inboxId: string | null = null;
  if (typeof a.inbox_id === "string" && a.inbox_id) {
    if (!ctx.inboxIds.has(a.inbox_id)) return reject("inbox_not_allowed", "Unknown inbox_id. Use one from the inbox list.");
    inboxId = a.inbox_id;
  } else if (name !== "contact_search") {
    if (!ctx.defaultInboxId) return reject("inbox_not_allowed", "inbox_id is required. Use one from the inbox list.");
    inboxId = ctx.defaultInboxId;
  }

  const args: Record<string, unknown> = {};
  if (inboxId) args.inbox_id = inboxId;
  if (action) args.action = action;
  const base = { ok: true as const, tool: name, action, args, inboxId, fanOut: false };

  switch (name) {
    case "folder_list":
      return { ...base, readOnly: true, messageIds: [] };
    case "draft_list":
      args.limit = int(a.limit, 1, 20, 10);
      return { ...base, readOnly: true, messageIds: [] };
    case "contact_search": {
      const query = text(a.query, 200);
      if (!query) return reject("invalid_arguments", "query is required.");
      args.query = query;
      args.limit = int(a.limit, 1, 10, 5);
      return { ...base, readOnly: true, messageIds: [] };
    }
    case "email_read":
      return sanitizeRead(action, a, args, base, ctx);
    case "email_organize":
    case "email_delete":
      break;
  }

  // Mutations.
  const single = id(a.message_id);
  const many = ids(a.message_ids);
  let messageIds: string[];
  if (action === "move" || action === "delete") {
    if (!single) return reject("invalid_arguments", "message_id is required.");
    messageIds = [single];
    args.message_id = single;
  } else if (action === "archive") {
    messageIds = single ? [single] : many ?? [];
    if (!messageIds.length) return reject("invalid_arguments", "message_id or message_ids is required.");
  } else {
    if (!many || !many.length) return reject("invalid_arguments", "message_ids is required.");
    messageIds = many;
    args.message_ids = many;
  }
  if (messageIds.length > L.mutateBatchMax) {
    return reject("batch_too_large", `At most ${L.mutateBatchMax} messages per call.`);
  }
  if (ctx.mutated + messageIds.length > L.maxMutatedPerRun) {
    return reject(
      "mutation_budget_exhausted",
      `This request may change at most ${L.maxMutatedPerRun} messages. Stop and tell the user how far you got.`,
    );
  }
  if (action === "move" || action === "move_batch") {
    const dest = text(a.destination_folder_id, 500);
    if (!dest) return reject("invalid_arguments", "destination_folder_id is required.");
    args.destination_folder_id = dest;
  }
  if (action === "flag") {
    const fa = a.flag_action;
    if (typeof fa !== "string" || !(FLAG_ACTIONS as readonly string[]).includes(fa)) {
      return reject("invalid_arguments", `flag_action must be one of: ${FLAG_ACTIONS.join(", ")}.`);
    }
    args.flag_action = fa;
  }
  // Trash only. Set here, unconditionally: the model's own value is never read.
  if (name === "email_delete") args.permanent = false;
  if (action === "archive") {
    args.message_id = messageIds[0];
    return { ...base, readOnly: false, messageIds, fanOut: messageIds.length > 1 };
  }
  return { ...base, readOnly: false, messageIds };
}

function sanitizeRead(
  action: string,
  a: Record<string, unknown>,
  args: Record<string, unknown>,
  base: Omit<SanitizedCall, "readOnly" | "messageIds">,
  ctx: PolicyContext,
): SanitizedCall | RejectedCall {
  const L = ctx.limits;
  if (action === "list") {
    const folder = text(a.folder, 300);
    if (folder) args.folder = folder;
    args.limit = int(a.limit, 1, L.listLimitMax, L.listLimitDefault);
    const offset = int(a.offset, 0, 5_000, 0);
    if (offset) args.offset = offset;
    if (typeof a.unread === "boolean") args.unread = a.unread;
    return { ...base, readOnly: true, messageIds: [] };
  }
  if (action === "search") {
    let any = false;
    for (const k of ["query", "from", "to", "subject", "body"] as const) {
      const v = text(a[k], 200);
      if (v) {
        args[k] = v;
        any = true;
      }
    }
    for (const k of ["since", "before"] as const) {
      const v = text(a[k], 40);
      if (v && !Number.isNaN(Date.parse(v))) {
        args[k] = v;
        any = true;
      }
    }
    for (const k of ["unread", "has_attachment", "flagged"] as const) {
      if (typeof a[k] === "boolean") {
        args[k] = a[k];
        any = true;
      }
    }
    if (!any) return reject("invalid_arguments", "search needs at least one filter.");
    const folders = Array.isArray(a.include_folders)
      ? a.include_folders.filter((f): f is string => typeof f === "string" && !!f).slice(0, 5).map((f) => clip(f, 300))
      : [];
    if (folders.length) args.include_folders = folders;
    args.limit = int(a.limit, 1, L.listLimitMax, L.listLimitDefault);
    const offset = int(a.offset, 0, 5_000, 0);
    if (offset) args.offset = offset;
    return { ...base, readOnly: true, messageIds: [] };
  }

  // Bodies. Plain text only, windowed: HTML and attachments are never requested.
  let messageIds: string[];
  if (action === "read") {
    const one = id(a.message_id);
    if (!one) return reject("invalid_arguments", "message_id is required.");
    messageIds = [one];
    args.message_id = one;
    const offset = int(a.body_offset, 0, 2_000_000, 0);
    if (offset) args.body_offset = offset;
    args.body_max_chars = L.bodyMaxChars;
  } else {
    const many = ids(a.message_ids);
    if (!many || !many.length) return reject("invalid_arguments", "message_ids is required.");
    if (many.length > L.readBatchMax) return reject("batch_too_large", `At most ${L.readBatchMax} messages per read_batch.`);
    messageIds = many;
    args.message_ids = many;
    args.body_max_chars = L.batchBodyMaxChars;
  }
  if (ctx.bodiesRead + messageIds.length > L.maxBodiesPerRun) {
    return reject(
      "read_budget_exhausted",
      `This request may read at most ${L.maxBodiesPerRun} email bodies and ${ctx.bodiesRead} are used. ` +
        "Answer from what you have and tell the user you did not read everything.",
    );
  }
  args.include_html = false;
  args.include_attachments = false;
  return { ...base, readOnly: true, messageIds };
}

function reject(code: RejectCode, message: string): RejectedCall {
  return { ok: false, code, message };
}
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
function text(v: unknown, max: number): string {
  return typeof v === "string" ? clip(v.trim(), max) : "";
}
function id(v: unknown): string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS ? v : "";
}
/** null when the value is not a list of ids; duplicates removed. */
function ids(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    const one = id(x);
    if (!one) return null;
    if (!out.includes(one)) out.push(one);
  }
  return out;
}
function int(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/* ---------------- tool definitions shown to the model ---------------- */

const INBOX_PROP = { type: "string", description: "inbox_id from the inbox list." };
const IDS_PROP = { type: "array", items: { type: "string" }, description: "Message ids from email_read." };

/** Compact, assistant-specific definitions. Same tool names and argument
 *  names as the MCP layer, minus every action and option the policy removes,
 *  so the model is never shown something it cannot use. */
export function modelTools(available: ReadonlySet<string>, limits: Limits): LlmToolDef[] {
  const tools: LlmToolDef[] = [
    {
      name: "email_read",
      description: "Read mail in one inbox. list: recent messages of a folder (previews). search: filters, ANDed. " +
        "read: one full plain-text body. read_batch: several bodies at once (shorter window). " +
        "list and search return one page: has_more with next_offset means there is more.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "read", "read_batch", "search"] },
          inbox_id: INBOX_PROP,
          folder: {
            type: "string",
            description: "list: folder id from folder_list, or inbox, sent, drafts, trash, archive, spam. Default inbox.",
          },
          unread: { type: "boolean", description: "list/search: only unread (true) or only read (false)." },
          limit: { type: "integer", description: `list/search: page size, max ${limits.listLimitMax}.` },
          offset: { type: "integer" },
          message_id: { type: "string", description: "read" },
          message_ids: { ...IDS_PROP, description: `read_batch: up to ${limits.readBatchMax} ids.` },
          body_offset: { type: "integer", description: "read: continue a truncated body from body_next_offset." },
          query: { type: "string", description: "search: free text." },
          from: { type: "string", description: "search: sender name or address." },
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          since: { type: "string", description: "search: ISO date, inclusive." },
          before: { type: "string", description: "search: ISO date, exclusive." },
          has_attachment: { type: "boolean" },
          flagged: { type: "boolean", description: "search: starred messages." },
        },
        required: ["action", "inbox_id"],
      },
    },
    {
      name: "email_organize",
      description: "Change mail in one inbox, by message id. move / move_batch: into destination_folder_id (a folder id " +
        "from folder_list). archive: out of the Inbox (message_id, or message_ids for several). flag: flag_action " +
        "read | unread | flag (star) | unflag on message_ids. The user can undo all of these.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["move", "move_batch", "archive", "flag"] },
          inbox_id: INBOX_PROP,
          message_id: { type: "string", description: "move, archive" },
          message_ids: { ...IDS_PROP, description: `move_batch, archive, flag: up to ${limits.mutateBatchMax} ids.` },
          destination_folder_id: { type: "string" },
          flag_action: { type: "string", enum: [...FLAG_ACTIONS] },
        },
        required: ["action", "inbox_id"],
      },
    },
    {
      name: "email_delete",
      description: "Move messages to Trash (recoverable). delete: one message_id. delete_batch: message_ids. " +
        "Permanent deletion is not available.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["delete", "delete_batch"] },
          inbox_id: INBOX_PROP,
          message_id: { type: "string" },
          message_ids: IDS_PROP,
        },
        required: ["action", "inbox_id"],
      },
    },
    {
      name: "folder_list",
      description: "Folders (or labels) of one inbox with their ids and counts.",
      parameters: { type: "object", properties: { inbox_id: INBOX_PROP }, required: ["inbox_id"] },
    },
    {
      name: "contact_search",
      description: "Find people the user has corresponded with, by name or address.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, inbox_id: INBOX_PROP, limit: { type: "integer" } },
        required: ["query"],
      },
    },
    {
      name: "draft_list",
      description: "Saved drafts of one inbox (subject and recipients, no bodies).",
      parameters: { type: "object", properties: { inbox_id: INBOX_PROP, limit: { type: "integer" } }, required: ["inbox_id"] },
    },
  ];
  const virtual: LlmToolDef[] = [
    {
      name: "write_draft",
      description: "Write an email into the user's compose view, where they see it appear and can edit it. " +
        "It is NOT sent and NOT saved. Give the arguments in the order listed, body last.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["reply", "reply_all", "new", "forward"] },
          reply_to: {
            type: "object",
            description: "reply, reply_all, forward: the email this answers or forwards.",
            properties: { inbox_id: { type: "string" }, message_id: { type: "string" } },
            required: ["inbox_id", "message_id"],
          },
          inbox_id: { type: "string", description: "new: the inbox to send from." },
          to: {
            type: "string",
            description: "Recipient addresses, comma separated. Every address the user named for this email goes here. " +
              "Empty only when the user has not said who it goes to: never guess one.",
          },
          cc: { type: "string", description: "Comma separated, or empty." },
          subject: { type: "string" },
          body: { type: "string", description: "Plain text. No subject line, no quoted original." },
        },
        required: ["kind", "to", "subject", "body"],
      },
    },
    {
      name: "edit_draft",
      description: "Change the current draft: its body, its recipients (to, cc) or its subject. Give only what changes. " +
        "A new body must be the COMPLETE text; the user sees the changes highlighted. Only when a current draft exists.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Only when the recipients should change: the complete new list, comma separated." },
          cc: { type: "string", description: "Only when cc should change: the complete new list, or empty to clear it." },
          subject: { type: "string", description: "Only when the subject should change." },
          body: { type: "string", description: "Only when the text should change: the complete new plain-text body." },
        },
      },
    },
    {
      name: "request_send",
      description: "Ask the user to approve sending the current draft. You cannot send mail yourself: this shows the " +
        "draft for approval and ends your turn. Only when the user asked in this request to send. When the user names " +
        "the recipient in the same request (\"send it to ...\"), pass it in `to`: the draft sent for approval must carry it.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipients the user named, comma separated. Omit to keep the draft's own. Never invent one." },
          cc: { type: "string", description: "Only when cc should change." },
          subject: { type: "string", description: "Only when the subject should change." },
        },
      },
    },
  ];
  return [...tools.filter((t) => available.has(t.name)), ...virtual];
}
