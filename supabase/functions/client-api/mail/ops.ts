// ---------------------------------------------------------------------------
// The mail operations `POST /mail` accepts, and how each maps onto the tool
// layer.
//
// Every op names the executor(s) it runs by DISPATCH NAME (the per-action
// names `dispatchExecutor` switches on: `email_list`, `email_move_batch`, …)
// and builds that executor's arguments from a validated, closed set of keys.
// Nothing the browser sends reaches an executor unless an op here copied it:
// unknown ops and unknown argument keys are refused, sizes are capped.
//
// `kind` drives three things: the viewer gate (a viewer may only `read`), the
// rate-limit class, and whether the cached inbox row may be used (`send` ops
// always re-read it, so a signature or credential change is never stale).
// ---------------------------------------------------------------------------

import { invalidRequest } from "../errors.ts";

export type OpKind = "read" | "write" | "send";

export interface ExecutorCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface OpSpec {
  kind: OpKind;
  /** `inbox_id` is required (false: the op may span the workspace). */
  needsInbox: boolean;
  /** `args.idempotency_key`: must be present, may be present, or is ignored. */
  idempotency: "required" | "optional" | "none";
  /** Ask list/search for `is_flagged` on each row, and read for `is_flagged` + `folder`. */
  flagged?: boolean;
  /** Handled by client-api itself rather than by an executor. */
  special?: "status" | "attachment" | "thread";
  /**
   * Rows carry the threading headers (`message_id_header`, `in_reply_to`,
   * `references`) and the `thread_key` computed from them (mail/thread-key.ts).
   */
  threads?: boolean;
  /**
   * IMAP: every command this op sends after SELECT addresses messages by UID
   * (UID FETCH / STORE / MOVE / SEARCH / EXPUNGE). The session pool may then
   * re-enter an already selected mailbox with NOOP instead of SELECT
   * (imap-pool.ts `reuseSelection`). NOT for `list`, which fetches by
   * sequence number and needs the count a real SELECT reports.
   */
  uidOnly?: boolean;
  /** IMAP: this op is the folder listing; it never reads the pool's remembered list. */
  freshList?: boolean;
  /**
   * Place in the per-inbox IMAP queue (imap-pool.ts rule 8). `interactive`:
   * a person is waiting for exactly this (`list`, `read`); it goes ahead of
   * queued `background` polls (`status`, `folders`). Absent: plain FIFO.
   */
  priority?: "interactive" | "background";
  /** The result is a folder listing: every entry gets `role` (mail/roles.ts). */
  roles?: boolean;
  /** `combine` needs to know the inbox's provider. */
  needsProvider?: boolean;
  build(args: Record<string, unknown>): ExecutorCall[];
  /** Fold the executor results into the op's one result. */
  combine?(results: unknown[], calls: ExecutorCall[], context: CombineContext): unknown;
}

export interface CombineContext {
  /** `inboxes.provider` of the op's inbox, or null when it could not be read. */
  provider: string | null;
}

/**
 * THE result of `move`, `archive` and `delete`, for every provider. One row
 * per message id that was asked for, in the order asked.
 *
 *   success: true   the message was relocated. `new_message_id` is the id it
 *                   has NOW: the same id on Gmail and Outlook (their ids
 *                   survive a move), the new id on IMAP when the server
 *                   reported it (COPYUID, RFC 4315), and null when the id is
 *                   not known (an IMAP server without UIDPLUS) or there is no
 *                   message any more (`delete` with `permanent: true`). A null
 *                   id means the old id no longer resolves: re-list to find it.
 *   success: false  nothing happened to this message; `error` says why
 *                   (`not_processed` = the call stopped before reaching it).
 */
export interface RelocateResult {
  succeeded: number;
  failed: number;
  results: Array<
    | { message_id: string; success: true; new_message_id: string | null }
    | { message_id: string; success: false; error: string }
  >;
}

/** Folds what the move / archive / delete executors return into {@link RelocateResult}. */
export function relocateResult(
  raw: unknown,
  call: ExecutorCall,
  context: CombineContext,
  options: { gone?: boolean } = {},
): RelocateResult {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const asked: string[] = Array.isArray(call.args["message_ids"])
    ? (call.args["message_ids"] as string[])
    : typeof call.args["message_id"] === "string"
    ? [call.args["message_id"] as string]
    : [];
  // Gmail and Outlook (immutable ids) keep a message's id across a move.
  const stable = context.provider === "gmail" || context.provider === "outlook";
  const after = (id: string, reported: unknown): string | null =>
    options.gone ? null : typeof reported === "string" && reported ? reported : stable ? id : null;

  const rows = new Map<string, RelocateResult["results"][number]>();
  if (Array.isArray(body["results"])) {
    for (const entry of body["results"] as Array<Record<string, unknown>>) {
      const id = typeof entry?.["message_id"] === "string" ? entry["message_id"] as string : null;
      if (id === null) continue;
      rows.set(
        id,
        entry["success"] === true
          ? { message_id: id, success: true, new_message_id: after(id, entry["new_message_id"]) }
          : { message_id: id, success: false, error: typeof entry["error"] === "string" ? entry["error"] as string : "failed" },
      );
    }
  } else if (body["success"] === true && asked.length === 1) {
    // The single-message executors answer `{ success, message_id, new_message_id? }`.
    rows.set(asked[0], { message_id: asked[0], success: true, new_message_id: after(asked[0], body["new_message_id"]) });
  }
  // The executors de-duplicate ids; so does the result.
  const results = [...new Set(asked)].map((id) =>
    rows.get(id) ?? { message_id: id, success: false as const, error: "not_processed" }
  );
  const succeeded = results.filter((row) => row.success).length;
  return { succeeded, failed: results.length - succeeded, results };
}

export const MAX_BATCH_CALLS = 12;
const MAX_IDS = 500;
const MAX_READ_BATCH = 50;
const MAX_ID_CHARS = 2048;
const MAX_RECIPIENTS = 100;
const MAX_SUBJECT_CHARS = 998;
const MAX_BODY_CHARS = 2_000_000;
const MAX_HTML_CHARS = 5_000_000;
const MAX_QUERY_CHARS = 2000;
const MAX_FOLDERS = 20;

type Args = Record<string, unknown>;

function only(args: Args, allowed: readonly string[], op: string): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw invalidRequest(`${op}: unknown argument '${key.slice(0, 64)}'.`);
  }
}

function str(args: Args, key: string, op: string, opts: { required?: boolean; max?: number; allowEmpty?: boolean } = {}): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (opts.required) throw invalidRequest(`${op}: '${key}' is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw invalidRequest(`${op}: '${key}' must be a string.`);
  if (!opts.allowEmpty && value.length === 0) {
    if (opts.required) throw invalidRequest(`${op}: '${key}' is required.`);
    return undefined;
  }
  if (value.length > (opts.max ?? MAX_ID_CHARS)) throw invalidRequest(`${op}: '${key}' is too long.`);
  return value;
}

function bool(args: Args, key: string, op: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalidRequest(`${op}: '${key}' must be true or false.`);
  return value;
}

function int(args: Args, key: string, op: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(`${op}: '${key}' must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function strList(
  args: Args,
  key: string,
  op: string,
  opts: { required?: boolean; max: number; maxChars?: number },
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (opts.required) throw invalidRequest(`${op}: '${key}' is required.`);
    return undefined;
  }
  if (!Array.isArray(value)) throw invalidRequest(`${op}: '${key}' must be an array.`);
  if (opts.required && value.length === 0) throw invalidRequest(`${op}: '${key}' must not be empty.`);
  if (value.length > opts.max) throw invalidRequest(`${op}: '${key}' accepts at most ${opts.max} entries.`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > (opts.maxChars ?? MAX_ID_CHARS)) {
      throw invalidRequest(`${op}: every '${key}' entry must be a non-empty string.`);
    }
    out.push(entry);
  }
  return out;
}

/** Recipients as plain address strings. Accepts `"a@b"` or `{ email, name? }`. */
function recipients(args: Args, key: string, op: string, required = false): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw invalidRequest(`${op}: '${key}' is required.`);
    return undefined;
  }
  if (!Array.isArray(value)) throw invalidRequest(`${op}: '${key}' must be an array of addresses.`);
  if (required && value.length === 0) throw invalidRequest(`${op}: '${key}' needs at least one address.`);
  if (value.length > MAX_RECIPIENTS) throw invalidRequest(`${op}: '${key}' accepts at most ${MAX_RECIPIENTS} addresses.`);
  return value.map((entry) => {
    const email = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && typeof (entry as { email?: unknown }).email === "string"
      ? (entry as { email: string }).email
      : null;
    if (email === null || email.length === 0 || email.length > 320 || /[\r\n]/.test(email)) {
      throw invalidRequest(`${op}: '${key}' contains an invalid address.`);
    }
    return email;
  });
}

function attachments(args: Args, op: string): unknown[] | undefined {
  const value = args["attachments"];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw invalidRequest(`${op}: 'attachments' must be an array of at most 20 files.`);
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidRequest(`${op}: every attachment must be an object.`);
    }
  }
  return value;
}

/** Copy the defined values only, so an absent key stays absent for the executor. */
function defined(values: Args): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined) out[key] = value;
  return out;
}

const messageIds = (args: Args, op: string, max = MAX_IDS) =>
  strList(args, "message_ids", op, { required: true, max })!;

function composeFields(args: Args, op: string): Args {
  return defined({
    cc: recipients(args, "cc", op),
    bcc: recipients(args, "bcc", op),
    html_body: str(args, "html_body", op, { max: MAX_HTML_CHARS }),
    include_signature: bool(args, "include_signature", op),
    from: str(args, "from", op, { max: 320 }),
  });
}

export const OPS: Record<string, OpSpec> = {
  list: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    flagged: true,
    threads: true,
    priority: "interactive",
    build(args) {
      // `preview: false` is read by runMailOp (no body bytes are fetched on
      // IMAP and every row's `preview` is ""); it is not an executor argument.
      only(args, ["folder", "limit", "offset", "unread", "preview"], "list");
      bool(args, "preview", "list");
      return [{
        tool: "email_list",
        args: defined({
          folder: str(args, "folder", "list", { max: 1024 }),
          limit: int(args, "limit", "list", 1, 100) ?? 50,
          offset: int(args, "offset", "list", 0, 1_000_000) ?? 0,
          unread: bool(args, "unread", "list"),
        }),
      }];
    },
  },

  read: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    // The result carries `is_flagged` and `folder` (see first-party.ts).
    flagged: true,
    threads: true,
    uidOnly: true,
    priority: "interactive",
    build(args) {
      only(args, [
        "message_id",
        "include_html",
        "include_attachments",
        "body_offset",
        "body_html_offset",
        "body_max_chars",
      ], "read");
      return [{
        tool: "email_read",
        args: defined({
          message_id: str(args, "message_id", "read", { required: true }),
          include_html: bool(args, "include_html", "read") ?? true,
          include_attachments: bool(args, "include_attachments", "read") ?? false,
          body_offset: int(args, "body_offset", "read", 0, 100_000_000),
          body_html_offset: int(args, "body_html_offset", "read", 0, 100_000_000),
          body_max_chars: int(args, "body_max_chars", "read", 1, 10_000_000),
        }),
      }];
    },
  },

  read_batch: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    uidOnly: true,
    build(args) {
      only(args, ["message_ids", "include_html", "body_max_chars"], "read_batch");
      return [{
        tool: "email_read_batch",
        args: defined({
          message_ids: messageIds(args, "read_batch", MAX_READ_BATCH),
          include_html: bool(args, "include_html", "read_batch") ?? false,
          include_attachments: false,
          body_max_chars: int(args, "body_max_chars", "read_batch", 1, 10_000_000),
        }),
      }];
    },
  },

  search: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    flagged: true,
    threads: true,
    uidOnly: true,
    build(args) {
      const text = ["text", "from", "to", "cc", "subject", "body", "since", "before", "query"];
      only(args, [...text, "unread", "has_attachment", "flagged", "include_folders", "limit", "offset"], "search");
      const fields: Args = {};
      for (const key of text) fields[key] = str(args, key, "search", { max: MAX_QUERY_CHARS });
      return [{
        tool: "email_search",
        args: defined({
          ...fields,
          unread: bool(args, "unread", "search"),
          has_attachment: bool(args, "has_attachment", "search"),
          flagged: bool(args, "flagged", "search"),
          include_folders: strList(args, "include_folders", "search", { max: MAX_FOLDERS, maxChars: 1024 }),
          limit: int(args, "limit", "search", 1, 100) ?? 50,
          offset: int(args, "offset", "search", 0, 1_000_000) ?? 0,
        }),
      }];
    },
  },

  // The messages of one conversation across folders, without bodies. The
  // contract, the per-provider behaviour and the bounds are in mail/thread.ts.
  thread: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    special: "thread",
    flagged: true,
    threads: true,
    uidOnly: true,
    // The thread fills in behind what the person is already reading: a `list`
    // or `read` that is waiting for the connection goes first (imap-pool.ts
    // rule 8), and the op gives the connection back between folders.
    priority: "background",
    build(args) {
      only(args, ["message_id", "thread_key", "limit"], "thread");
      return [{
        tool: "thread",
        args: defined({
          message_id: str(args, "message_id", "thread", { required: true }),
          thread_key: str(args, "thread_key", "thread", { max: MAX_ID_CHARS }),
          limit: int(args, "limit", "thread", 1, 100),
        }),
      }];
    },
  },

  folders: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    freshList: true,
    roles: true,
    priority: "background",
    build(args) {
      only(args, [], "folders");
      return [{ tool: "folder_list", args: {} }];
    },
  },

  status: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    special: "status",
    priority: "background",
    build(args) {
      only(args, ["folders"], "status");
      const folders = strList(args, "folders", "status", { max: MAX_FOLDERS, maxChars: 1024 }) ?? ["inbox"];
      return [{ tool: "status", args: { folders: folders.length > 0 ? folders : ["inbox"] } }];
    },
  },

  flag: {
    kind: "write",
    needsInbox: true,
    // Setting a flag twice is the same as setting it once: no ledger needed,
    // and none of its three database round trips on the hottest write.
    idempotency: "none",
    uidOnly: true,
    build(args) {
      only(args, ["message_ids", "read", "starred", "idempotency_key"], "flag");
      const ids = messageIds(args, "flag");
      const read = bool(args, "read", "flag");
      const starred = bool(args, "starred", "flag");
      if (read === undefined && starred === undefined) {
        throw invalidRequest("flag: give 'read', 'starred' or both.");
      }
      const calls: ExecutorCall[] = [];
      if (read !== undefined) {
        calls.push({ tool: "email_flag", args: { message_ids: ids, action: read ? "read" : "unread" } });
      }
      if (starred !== undefined) {
        calls.push({ tool: "email_flag", args: { message_ids: ids, action: starred ? "flag" : "unflag" } });
      }
      return calls;
    },
    combine(results, calls) {
      if (results.length === 1) return results[0];
      const out: Record<string, unknown> = {};
      calls.forEach((call, i) => {
        const action = String(call.args["action"]);
        out[action === "read" || action === "unread" ? "read" : "starred"] = results[i];
      });
      return out;
    },
  },

  move: {
    kind: "write",
    needsInbox: true,
    idempotency: "optional",
    needsProvider: true,
    uidOnly: true,
    build(args) {
      only(args, ["message_ids", "destination_folder_id", "idempotency_key"], "move");
      return [{
        tool: "email_move_batch",
        args: {
          message_ids: messageIds(args, "move"),
          destination_folder_id: str(args, "destination_folder_id", "move", { required: true, max: 1024 }),
        },
      }];
    },
    combine: (results, calls, context) => relocateResult(results[0], calls[0], context),
  },

  archive: {
    kind: "write",
    needsInbox: true,
    idempotency: "optional",
    needsProvider: true,
    uidOnly: true,
    build(args) {
      only(args, ["message_ids", "idempotency_key"], "archive");
      const ids = messageIds(args, "archive");
      // One id takes the archive executor; several take the batch move to the
      // `archive` alias, which is what the tool layer documents for this.
      return ids.length === 1
        ? [{ tool: "email_archive", args: { message_id: ids[0] } }]
        : [{ tool: "email_move_batch", args: { message_ids: ids, destination_folder_id: "archive" } }];
    },
    combine: (results, calls, context) => relocateResult(results[0], calls[0], context),
  },

  delete: {
    kind: "write",
    needsInbox: true,
    idempotency: "optional",
    needsProvider: true,
    uidOnly: true,
    build(args) {
      only(args, ["message_ids", "permanent", "idempotency_key"], "delete");
      return [{
        tool: "email_delete_batch",
        args: {
          message_ids: messageIds(args, "delete"),
          permanent: bool(args, "permanent", "delete") ?? false,
        },
      }];
    },
    combine: (results, calls, context) =>
      relocateResult(results[0], calls[0], context, { gone: calls[0].args["permanent"] === true }),
  },

  send: {
    kind: "send",
    needsInbox: true,
    idempotency: "required",
    build(args) {
      only(args, [
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "html_body",
        "reply_to",
        "from",
        "include_signature",
        "attachments",
        "idempotency_key",
      ], "send");
      return [{
        tool: "email_send",
        args: defined({
          to: recipients(args, "to", "send", true),
          subject: str(args, "subject", "send", { required: true, max: MAX_SUBJECT_CHARS, allowEmpty: true }),
          body: str(args, "body", "send", { required: true, max: MAX_BODY_CHARS, allowEmpty: true }),
          reply_to: str(args, "reply_to", "send", { max: 320 }),
          attachments: attachments(args, "send"),
          ...composeFields(args, "send"),
        }),
      }];
    },
  },

  reply: {
    kind: "send",
    needsInbox: true,
    idempotency: "required",
    build(args) {
      only(args, [
        "message_id",
        "to",
        "body",
        "html_body",
        "reply_all",
        "cc",
        "bcc",
        "from",
        "include_signature",
        "attachments",
        "idempotency_key",
      ], "reply");
      // Recipients. The reply is threaded under `message_id` either way
      // (In-Reply-To / References, Gmail threadId, Graph createReply).
      //   `to` given    the lists are EXPLICIT: To is exactly `to`, Cc exactly
      //                 `cc`, Bcc exactly `bcc`. Nothing is derived from the
      //                 original, and `reply_all` changes nothing.
      //   `to` absent   To is DERIVED: the original's sender, or with
      //                 `reply_all` everyone on it except this mailbox. `cc`
      //                 and `bcc` are then additions to that.
      const to = recipients(args, "to", "reply");
      return [{
        tool: "email_reply",
        args: defined({
          message_id: str(args, "message_id", "reply", { required: true }),
          to: to && to.length > 0 ? to : undefined,
          body: str(args, "body", "reply", { required: true, max: MAX_BODY_CHARS, allowEmpty: true }),
          reply_all: bool(args, "reply_all", "reply"),
          attachments: attachments(args, "reply"),
          ...composeFields(args, "reply"),
        }),
      }];
    },
  },

  forward: {
    kind: "send",
    needsInbox: true,
    idempotency: "required",
    build(args) {
      only(args, [
        "message_id",
        "to",
        "cc",
        "bcc",
        "body",
        "html_body",
        "include_attachments",
        "as_attachment",
        "from",
        "include_signature",
        "idempotency_key",
      ], "forward");
      return [{
        tool: "email_forward",
        args: defined({
          message_id: str(args, "message_id", "forward", { required: true }),
          to: recipients(args, "to", "forward", true),
          body: str(args, "body", "forward", { max: MAX_BODY_CHARS, allowEmpty: true }),
          include_attachments: bool(args, "include_attachments", "forward"),
          as_attachment: bool(args, "as_attachment", "forward"),
          ...composeFields(args, "forward"),
        }),
      }];
    },
  },

  draft_list: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    build(args) {
      only(args, ["limit"], "draft_list");
      return [{ tool: "draft_list", args: defined({ limit: int(args, "limit", "draft_list", 1, 50) }) }];
    },
  },

  draft_read: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    uidOnly: true,
    build(args) {
      only(args, ["draft_id", "include_html"], "draft_read");
      // draft_list rows carry no body; a draft is read as the message it is.
      return [{
        tool: "email_read",
        args: {
          message_id: str(args, "draft_id", "draft_read", { required: true }),
          include_html: bool(args, "include_html", "draft_read") ?? true,
          include_attachments: false,
        },
      }];
    },
  },

  draft_create: {
    kind: "write",
    needsInbox: true,
    idempotency: "optional",
    build(args) {
      only(args, [
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "html_body",
        "include_signature",
        "message_id",
        "reply_all",
        "idempotency_key",
      ], "draft_create");
      const replyTo = str(args, "message_id", "draft_create");
      const body = str(args, "body", "draft_create", { required: true, max: MAX_BODY_CHARS, allowEmpty: true });
      const shared = defined({
        cc: recipients(args, "cc", "draft_create"),
        bcc: recipients(args, "bcc", "draft_create"),
        html_body: str(args, "html_body", "draft_create", { max: MAX_HTML_CHARS }),
        include_signature: bool(args, "include_signature", "draft_create"),
      });
      if (replyTo !== undefined) {
        // A draft that threads under a message: the reply-draft executor
        // derives recipients and subject from the original.
        return [{
          tool: "draft_reply",
          args: defined({
            message_id: replyTo,
            body,
            reply_all: bool(args, "reply_all", "draft_create"),
            ...shared,
          }),
        }];
      }
      return [{
        tool: "draft_create",
        args: defined({
          to: recipients(args, "to", "draft_create"),
          subject: str(args, "subject", "draft_create", { max: MAX_SUBJECT_CHARS, allowEmpty: true }) ?? "",
          body,
          ...shared,
        }),
      }];
    },
  },

  draft_update: {
    kind: "write",
    needsInbox: true,
    idempotency: "optional",
    build(args) {
      only(args, [
        "draft_id",
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "html_body",
        "include_signature",
        "idempotency_key",
      ], "draft_update");
      return [{
        tool: "draft_update",
        args: defined({
          draft_id: str(args, "draft_id", "draft_update", { required: true }),
          to: recipients(args, "to", "draft_update"),
          cc: recipients(args, "cc", "draft_update"),
          bcc: recipients(args, "bcc", "draft_update"),
          subject: str(args, "subject", "draft_update", { max: MAX_SUBJECT_CHARS, allowEmpty: true }),
          body: str(args, "body", "draft_update", { required: true, max: MAX_BODY_CHARS, allowEmpty: true }),
          html_body: str(args, "html_body", "draft_update", { max: MAX_HTML_CHARS }),
          include_signature: bool(args, "include_signature", "draft_update"),
        }),
      }];
    },
  },

  draft_delete: {
    kind: "write",
    needsInbox: true,
    idempotency: "optional",
    build(args) {
      only(args, ["draft_id", "idempotency_key"], "draft_delete");
      return [{ tool: "draft_delete", args: { draft_id: str(args, "draft_id", "draft_delete", { required: true }) } }];
    },
  },

  draft_send: {
    kind: "send",
    needsInbox: true,
    idempotency: "required",
    build(args) {
      only(args, ["draft_id", "to", "cc", "bcc", "idempotency_key"], "draft_send");
      return [{
        tool: "draft_send",
        args: defined({
          draft_id: str(args, "draft_id", "draft_send", { required: true }),
          to: recipients(args, "to", "draft_send"),
          cc: recipients(args, "cc", "draft_send"),
          bcc: recipients(args, "bcc", "draft_send"),
        }),
      }];
    },
  },

  schedule_list: {
    kind: "read",
    needsInbox: false,
    idempotency: "none",
    build(args) {
      // No `inbox_id`: every pending send of the workspace, each row carrying
      // its own `inbox_id`. With one: that inbox's only. The result is the
      // executor's: `{ scheduled_sends: [...], total }`.
      only(args, ["limit"], "schedule_list");
      return [{ tool: "schedule_list", args: defined({ limit: int(args, "limit", "schedule_list", 1, 100) }) }];
    },
  },

  schedule_create: {
    kind: "send",
    needsInbox: true,
    idempotency: "required",
    build(args) {
      only(args, [
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "html_body",
        "reply_to",
        "send_at",
        "attachments",
        "idempotency_key",
      ], "schedule_create");
      return [{
        tool: "schedule_create",
        args: defined({
          to: recipients(args, "to", "schedule_create", true),
          cc: recipients(args, "cc", "schedule_create"),
          bcc: recipients(args, "bcc", "schedule_create"),
          subject: str(args, "subject", "schedule_create", { required: true, max: MAX_SUBJECT_CHARS, allowEmpty: true }),
          body: str(args, "body", "schedule_create", { required: true, max: MAX_BODY_CHARS, allowEmpty: true }),
          html_body: str(args, "html_body", "schedule_create", { max: MAX_HTML_CHARS }),
          reply_to: str(args, "reply_to", "schedule_create", { max: 320 }),
          send_at: str(args, "send_at", "schedule_create", { required: true, max: 64 }),
          attachments: attachments(args, "schedule_create"),
        }),
      }];
    },
  },

  schedule_cancel: {
    kind: "write",
    needsInbox: false,
    idempotency: "none",
    build(args) {
      only(args, ["id"], "schedule_cancel");
      return [{ tool: "schedule_cancel", args: { id: str(args, "id", "schedule_cancel", { required: true, max: 64 }) } }];
    },
  },

  contacts: {
    kind: "read",
    needsInbox: false,
    idempotency: "none",
    build(args) {
      only(args, ["query", "limit", "offset"], "contacts");
      return [{
        tool: "contact_search",
        args: defined({
          query: str(args, "query", "contacts", { required: true, max: 200 }),
          limit: int(args, "limit", "contacts", 1, 50),
          offset: int(args, "offset", "contacts", 0, 10_000),
        }),
      }];
    },
  },

  attachment: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    special: "attachment",
    uidOnly: true,
    build(args) {
      only(args, ["message_id", "attachment_index", "filename"], "attachment");
      const index = int(args, "attachment_index", "attachment", 0, 10_000);
      const filename = str(args, "filename", "attachment", { max: 1024 });
      if (index === undefined && filename === undefined) {
        throw invalidRequest("attachment: give 'attachment_index' or 'filename'.");
      }
      return [{
        tool: "email_attachment",
        args: defined({
          message_id: str(args, "message_id", "attachment", { required: true }),
          attachment_index: index,
          filename,
        }),
      }];
    },
  },

  signature_get: {
    kind: "read",
    needsInbox: true,
    idempotency: "none",
    build(args) {
      only(args, [], "signature_get");
      return [{ tool: "signature_get", args: {} }];
    },
  },
};

export const OP_NAMES: readonly string[] = Object.keys(OPS);
