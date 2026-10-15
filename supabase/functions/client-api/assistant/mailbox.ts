/* Runs one sanitized mailbox call and turns the result into three things:
 *  - a compact JSON projection for the model (previews, windowed bodies);
 *  - `mail_effect`s that say exactly what changed, so the client can mirror
 *    the change in its lists and undo it;
 *  - a short human label / meta for the transcript.
 *
 * Everything the run learns about messages (sender, subject, folder) stays in
 * `RunMemory`, in memory, for the length of one request. Nothing here logs.
 */

import type { ToolRunner } from "./deps.ts";
import { type FolderRef, type MailEffect, makeKey, type MessageKey, type ToolName } from "./events.ts";
import type { FlagAction, Limits, SanitizedCall } from "./policy.ts";

export interface SeenEmail {
  name: string;
  email: string;
  subject: string;
  /** Provider folder id, when a listing told us. */
  folder?: string;
}

export type PendingEffect = Omit<MailEffect, "call_id">;

export class RunMemory {
  readonly seen = new Map<MessageKey, SeenEmail>();
  /** `${inbox_id}:${folder_id}` -> display name. */
  readonly folderNames = new Map<string, string>();
  bodiesRead = 0;
  mutated = 0;
  /** Listing/search hits, newest call last: candidates for answer chips. */
  readonly listed: MessageKey[] = [];
  readonly counts = { moved: 0, archived: 0, trashed: 0, flagged: 0 };
  lastMoveLabel = "";
  lastMoveTo: FolderRef | null = null;
  /** False once a move happened whose origin folder is unknown. */
  movesUndoable = true;

  note(key: MessageKey, patch: Partial<SeenEmail>): void {
    const cur = this.seen.get(key) ?? { name: "", email: "", subject: "" };
    this.seen.set(key, {
      name: patch.name || cur.name,
      email: patch.email || cur.email,
      subject: patch.subject || cur.subject,
      folder: patch.folder ?? cur.folder,
    });
  }

  sender(key: MessageKey): string {
    const s = this.seen.get(key);
    return s ? s.name || s.email : "";
  }
}

export interface CallView {
  tool: ToolName;
  action?: string;
  human: string;
  keys: MessageKey[];
  folder?: FolderRef;
}

const ROLE_ALIASES = ["inbox", "sent", "drafts", "trash", "archive", "spam"] as const;
type RoleAlias = (typeof ROLE_ALIASES)[number];

function roleAlias(folder: string): RoleAlias | null {
  const f = folder.toLowerCase();
  return (ROLE_ALIASES as readonly string[]).includes(f) ? (f as RoleAlias) : null;
}

function folderLabel(inboxId: string, folderId: string, mem: RunMemory): string {
  const known = mem.folderNames.get(`${inboxId}:${folderId}`);
  if (known) return known;
  const role = roleAlias(folderId);
  if (role) return role.charAt(0).toUpperCase() + role.slice(1);
  const plain = folderId.replace(/^\[(Gmail|Google Mail)\]\//i, "");
  return /^[\p{L}\p{N} _\-./&]{1,40}$/u.test(plain) ? plain : "a folder";
}

function plural(n: number): string {
  return n === 1 ? "1 email" : `${n} emails`;
}

/** What the transcript shows for a call before it runs. */
export function describeCall(call: SanitizedCall, mem: RunMemory): CallView {
  const inbox = call.inboxId ?? "";
  const keys = call.messageIds.map((m) => makeKey(inbox, m));
  const n = keys.length;
  const who = n === 1 ? mem.sender(keys[0] as MessageKey) : "";
  const a = call.args;
  switch (call.tool) {
    case "folder_list":
      return { tool: "folder_list", human: "Checking your folders", keys: [] };
    case "contact_search":
      return { tool: "contact_search", human: "Looking up a contact", keys: [] };
    case "draft_list":
      return { tool: "draft_list", human: "Checking your drafts", keys: [], folder: { role: "drafts" } };
    case "email_read": {
      if (call.action === "list") {
        const folder = typeof a.folder === "string" ? a.folder : "inbox";
        const role = roleAlias(folder);
        const label = folderLabel(inbox, folder, mem);
        return {
          tool: "email_read",
          action: "list",
          human: role === "inbox" ? "Checking your inbox" : `Checking ${label}`,
          keys: [],
          folder: role ? { role } : { inbox_id: inbox, folder_id: folder },
        };
      }
      if (call.action === "search") {
        const from = typeof a.from === "string" ? a.from : "";
        const terms = [a.query, a.subject, a.body].filter((x): x is string => typeof x === "string" && !!x).join(" ");
        const shown = terms.length > 48 ? `${terms.slice(0, 47)}…` : terms;
        const human = shown
          ? `Searching for ${shown}${from ? ` from ${from}` : ""}`
          : from
          ? `Searching for mail from ${from}`
          : "Searching your mail";
        return { tool: "email_search", action: "search", human, keys: [] };
      }
      const human = n === 1 ? (who ? `Reading ${who}'s email` : "Reading an email") : `Reading ${plural(n)}`;
      return { tool: "email_read", action: call.action, human, keys };
    }
    case "email_delete":
      return { tool: "email_delete", action: call.action, human: `Moving ${plural(n)} to Trash`, keys, folder: { role: "trash" } };
    case "email_organize": {
      if (call.action === "archive") {
        const human = n === 1 ? (who ? `Archiving ${who}'s email` : "Archiving an email") : `Archiving ${plural(n)}`;
        return { tool: "email_organize", action: "archive", human, keys, folder: { role: "archive" } };
      }
      if (call.action === "flag") {
        const verb: Record<FlagAction, string> = {
          read: `Marking ${plural(n)} as read`,
          unread: `Marking ${plural(n)} as unread`,
          flag: `Starring ${plural(n)}`,
          unflag: `Removing the star from ${plural(n)}`,
        };
        return { tool: "email_organize", action: "flag", human: verb[a.flag_action as FlagAction], keys };
      }
      const dest = String(a.destination_folder_id ?? "");
      const label = folderLabel(inbox, dest, mem);
      const subject = n === 1 ? (who ? `${who}'s email` : "an email") : plural(n);
      return {
        tool: "email_organize",
        action: call.action,
        human: `Moving ${subject} to ${label}`,
        keys,
        folder: { inbox_id: inbox, folder_id: dest },
      };
    }
  }
}

export interface CallOutcome {
  /** JSON text for the model. Mail content: never log it. */
  content: string;
  isError: boolean;
  effects: PendingEffect[];
  meta: string;
}

const MAX_RESULT_CHARS = 40_000;

export async function executeCall(
  call: SanitizedCall,
  runTool: ToolRunner,
  mem: RunMemory,
  limits: Limits,
): Promise<CallOutcome> {
  if (!call.readOnly) return await executeMutation(call, runTool, mem);
  let res: { result: unknown; isError: boolean };
  try {
    res = await runTool(call.tool, call.args);
  } catch {
    res = { result: { error: "The mailbox call failed." }, isError: true };
  }
  if (res.isError) return failure(res.result);
  const inbox = call.inboxId ?? "";
  const r = obj(res.result) ?? {};

  if (call.tool === "folder_list") {
    const folders = arr(r.folders).map(obj).filter(isObj).slice(0, 100).map((f) => {
      const fid = str(f.id);
      const name = str(f.name);
      if (fid && name) mem.folderNames.set(`${inbox}:${fid}`, name);
      return { id: fid, name, type: str(f.type) || undefined, total: num(f.total_messages), unread: num(f.unread_messages) };
    });
    return ok({ folders }, `${folders.length} folders`);
  }
  if (call.tool === "contact_search" || call.tool === "draft_list") {
    const out = ok(res.result, "");
    return { ...out, content: clip(out.content, 8_000) };
  }

  if (call.action === "list" || call.action === "search") {
    const rows = arr(r.messages).map(obj).filter(isObj).slice(0, limits.listLimitMax);
    const messages = rows.map((m) => {
      const from = obj(m.from) ?? {};
      const mid = str(m.id);
      const key = makeKey(inbox, mid);
      const folder = str(m.folder);
      mem.note(key, { name: str(from.name), email: str(from.email), subject: str(m.subject), folder: folder || undefined });
      if (!mem.listed.includes(key)) mem.listed.push(key);
      return {
        id: mid,
        from: address(from),
        subject: clip(str(m.subject), 200),
        date: str(m.date),
        preview: clip(str(m.preview), 200),
        unread: m.is_read === false,
        attachments: m.has_attachments === true || undefined,
        folder: folder || undefined,
      };
    });
    const total = num(r.total);
    const out = {
      messages,
      total,
      has_more: r.has_more === true,
      next_offset: num(r.next_offset),
      notes: arr(r.notes).filter((x): x is string => typeof x === "string").slice(0, 3),
    };
    const meta = call.action === "search" ? `${messages.length} found` : `${plural(messages.length)}`;
    return ok(out, meta);
  }

  // read / read_batch
  const bodyMax = call.action === "read" ? limits.bodyMaxChars : limits.batchBodyMaxChars;
  const list = call.action === "read" ? [r] : arr(r.messages).map(obj).filter(isObj);
  const keys: MessageKey[] = [];
  const messages = list.map((m) => {
    const from = obj(m.from) ?? {};
    const mid = str(m.id) || (call.action === "read" ? (call.messageIds[0] as string) : "");
    const key = makeKey(inbox, mid);
    keys.push(key);
    mem.note(key, { name: str(from.name), email: str(from.email), subject: str(m.subject) });
    const full = str(m.body_text);
    const body = clip(full, bodyMax);
    return {
      id: mid,
      from: address(from),
      to: arr(m.to).map(obj).filter(isObj).slice(0, 10).map(address),
      cc: arr(m.cc).map(obj).filter(isObj).slice(0, 10).map(address),
      subject: clip(str(m.subject), 300),
      date: str(m.date),
      body: body || "(no plain text body)",
      body_truncated: m.body_truncated === true || full.length > body.length || undefined,
      body_next_offset: num(m.body_next_offset) ?? undefined,
      attachments: arr(m.attachments).map(obj).filter(isObj).slice(0, 10).map((x) => ({
        filename: clip(str(x.filename), 120),
        size_bytes: num(x.size_bytes),
      })),
      unread: m.is_read === false,
    };
  });
  const effects: PendingEffect[] = keys.length ? [{ kind: "read", keys }] : [];
  const out = call.action === "read" ? (messages[0] ?? { error: "Message not found." }) : { messages };
  return { ...ok(out, ""), effects };
}

async function executeMutation(call: SanitizedCall, runTool: ToolRunner, mem: RunMemory): Promise<CallOutcome> {
  const inbox = call.inboxId ?? "";
  interface Row {
    message_id: string;
    success: boolean;
    new_message_id?: string;
    error?: string;
  }
  const rows: Row[] = [];
  let hardError: unknown = null;

  const one = async (args: Record<string, unknown>, ids: string[]) => {
    let res: { result: unknown; isError: boolean };
    try {
      res = await runTool(call.tool, args);
    } catch {
      res = { result: { error: "The mailbox call failed." }, isError: true };
    }
    if (res.isError) {
      hardError = res.result;
      for (const m of ids) rows.push({ message_id: m, success: false, error: clip(errorText(res.result), 160) });
      return;
    }
    const r = obj(res.result) ?? {};
    const results = arr(r.results).map(obj).filter(isObj);
    if (results.length) {
      const byId = new Map(results.map((x) => [str(x.message_id), x]));
      for (const m of ids) {
        const x = byId.get(m);
        // A message the provider did not report on is NOT assumed changed.
        if (!x) rows.push({ message_id: m, success: false, error: "not reported" });
        else {
          rows.push({
            message_id: m,
            success: x.success === true,
            new_message_id: str(x.new_message_id) || undefined,
            error: x.success === true ? undefined : clip(str(x.error), 160) || "failed",
          });
        }
      }
      return;
    }
    // Only an explicit `success: true` counts. A result that reports nothing
    // per message and does not say it succeeded (for one: the "plan" an inbox
    // with bulk review returns INSTEAD of moving anything) changed nothing.
    const success = r.success === true;
    const planned = !success && (typeof r.plan_id === "string" || r.status === "pending" || r.outcome === "planned");
    if (planned) hardError = "This inbox reviews bulk changes before they run. Tell the user to move these from the list.";
    for (const m of ids) {
      rows.push({
        message_id: m,
        success,
        new_message_id: ids.length === 1 ? str(r.new_message_id) || undefined : undefined,
        error: success ? undefined : planned ? "needs review" : "failed",
      });
    }
  };

  if (call.fanOut) {
    for (const m of call.messageIds) await one({ ...call.args, message_id: m }, [m]);
  } else {
    await one(call.args, call.messageIds);
  }

  const done = rows.filter((x) => x.success);
  const effects: PendingEffect[] = [];

  if (done.length) {
    if (call.action === "flag") {
      const fa = call.args.flag_action as FlagAction;
      const flags = fa === "read" ? { read: true } : fa === "unread" ? { read: false } : fa === "flag" ? { starred: true } : { starred: false };
      effects.push({ kind: "flagged", keys: done.map((x) => makeKey(inbox, x.message_id)), flags });
      mem.counts.flagged += done.length;
    } else {
      const isMove = call.action === "move" || call.action === "move_batch";
      const dest = isMove ? String(call.args.destination_folder_id) : "";
      const to: FolderRef = isMove
        ? { inbox_id: inbox, folder_id: dest }
        : call.tool === "email_delete"
        ? { role: "trash" }
        : { role: "archive" };
      // One effect per origin folder, so each can be reversed on its own.
      const groups = new Map<string, { from?: FolderRef; keys: MessageKey[]; new_keys: MessageKey[] }>();
      for (const x of done) {
        const key = makeKey(inbox, x.message_id);
        const seen = mem.seen.get(key);
        const fromFolder = seen?.folder ?? "";
        let from: FolderRef | undefined = fromFolder ? { inbox_id: inbox, folder_id: fromFolder } : undefined;
        // Archive is defined as "out of the Inbox": the origin is known.
        if (!from && call.action === "archive") from = { role: "inbox" };
        if (!from) mem.movesUndoable = false;
        const g = groups.get(fromFolder) ?? { from, keys: [], new_keys: [] };
        const newKey = makeKey(inbox, x.new_message_id || x.message_id);
        g.keys.push(key);
        g.new_keys.push(newKey);
        groups.set(fromFolder, g);
        // The message now lives elsewhere, possibly under a new id.
        if (seen) {
          mem.seen.delete(key);
          mem.seen.set(newKey, { ...seen, folder: isMove ? dest : undefined });
        }
      }
      for (const g of groups.values()) effects.push({ kind: "moved", keys: g.keys, new_keys: g.new_keys, from: g.from, to });
      if (isMove) {
        mem.counts.moved += done.length;
        mem.lastMoveLabel = folderLabel(inbox, dest, mem);
        mem.lastMoveTo = to;
      } else if (call.tool === "email_delete") mem.counts.trashed += done.length;
      else mem.counts.archived += done.length;
    }
  }

  const failed = rows.length - done.length;
  const content = JSON.stringify({
    succeeded: done.length,
    failed,
    results: rows,
    ...(failed && hardError ? { error: clip(errorText(hardError), 300) } : {}),
  });
  return {
    content: clip(content, MAX_RESULT_CHARS),
    isError: done.length === 0,
    effects,
    meta: done.length === 0 ? "failed" : failed ? `${done.length} done, ${failed} failed` : "",
  };
}

/** One line for the Undo bar, from what this run changed. */
export function runSummary(mem: RunMemory): { text: string; undoable: boolean } | undefined {
  const c = mem.counts;
  const parts: string[] = [];
  if (c.moved) parts.push(`Moved ${plural(c.moved)} to ${mem.lastMoveLabel || "a folder"}`);
  if (c.archived) parts.push(`${parts.length ? "archived" : "Archived"} ${plural(c.archived)}`);
  if (c.trashed) parts.push(`${parts.length ? "moved" : "Moved"} ${plural(c.trashed)} to Trash`);
  if (c.flagged) parts.push(`${parts.length ? "updated" : "Updated"} ${plural(c.flagged)}`);
  if (!parts.length) return undefined;
  const relocated = c.moved + c.archived + c.trashed;
  return { text: parts.join(", "), undoable: relocated > 0 && mem.movesUndoable };
}

function ok(value: unknown, meta: string): CallOutcome {
  let content: string;
  try {
    content = JSON.stringify(value) ?? "null";
  } catch {
    content = '{"error":"Unreadable result."}';
  }
  return { content: clip(content, MAX_RESULT_CHARS), isError: false, effects: [], meta };
}

function failure(result: unknown): CallOutcome {
  return { content: JSON.stringify({ error: clip(errorText(result), 300) }), isError: true, effects: [], meta: "failed" };
}

function errorText(result: unknown): string {
  if (typeof result === "string") return result;
  const r = obj(result);
  if (!r) return "The mailbox call failed.";
  const nested = obj(r.error);
  return str(nested?.message) || str(r.error) || str(r.message) || "The mailbox call failed.";
}

function address(a: Record<string, unknown>): string {
  const name = str(a.name);
  const email = str(a.email);
  return clip(name && email ? `${name} <${email}>` : name || email, 160);
}
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function isObj(v: Record<string, unknown> | undefined): v is Record<string, unknown> {
  return v !== undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
