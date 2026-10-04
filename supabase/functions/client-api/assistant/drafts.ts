/* The virtual tools: write_draft, edit_draft, request_send.
 *
 * None of them touches the mailbox. A draft exists only as events streamed to
 * the client's compose view (and as `current` for the rest of the run), and a
 * send is only ever a REQUEST: `approval_required` hands the draft to the
 * human, who sends it through the client's own mail op. This module has no
 * access to `runTool` at all.
 */

import type { Inbox } from "./deps.ts";
import { applySegments, diffWords } from "./diff.ts";
import {
  type ApprovalDraft,
  type AssistantEvent,
  type AssistantToolCall,
  type DraftFields,
  type DraftKind,
  type Emit,
  makeKey,
  type MessageKey,
} from "./events.ts";
import type { RunMemory } from "./mailbox.ts";
import { JsonArgStream, wellFormed } from "./partial-json.ts";
import type { Limits } from "./policy.ts";
import type { DraftState } from "./request.ts";

export interface DraftEnv {
  inboxes: Inbox[];
  userEmail: string;
  /** Inbox for a new email when the model names none. */
  defaultInboxId: string | null;
  /** The single attached email, when there is exactly one. */
  defaultReplyTo: { inbox_id: string; message_id: string } | null;
  mem: RunMemory;
  limits: Limits;
  emit: Emit;
  /** Emits (or re-emits) a transcript call. */
  showCall(messageId: string, call: AssistantToolCall): void;
  sleep(ms: number): Promise<void>;
}

/** Result handed back to the model for a virtual tool. */
export interface VirtualOutcome {
  content: string;
  isError: boolean;
}

const KINDS: readonly DraftKind[] = ["reply", "reply_all", "new", "forward"];

/** Consumer mail domains: sharing one says nothing about being the same organisation. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "hey.com",
]);

/** "Maya <maya@x.io>, b@y.io" -> addresses. `invalid` when any part is not one. */
export function parseAddresses(input: string): { list: string[]; invalid: boolean } {
  const list: string[] = [];
  let invalid = false;
  for (const part of input.split(/[,;\n]+/)) {
    const s = part.trim();
    if (!s) continue;
    const m = /<([^<>]+)>\s*$/.exec(s);
    const addr = (m ? (m[1] as string) : s).trim();
    if (/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;".]+$/.test(addr) && addr.length <= 254) {
      if (!list.includes(addr)) list.push(addr);
    } else invalid = true;
  }
  return { list, invalid };
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** True when any recipient is outside the user's own addresses and domains.
 *  No recipients, or anything unparseable, counts as external: fail closed. */
export function isExternal(recipients: string[], ownAddresses: string[]): boolean {
  if (!recipients.length) return true;
  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@")));
  const ownDomains = new Set([...own].map(domainOf).filter((d) => !PUBLIC_DOMAINS.has(d)));
  return recipients.some((r) => {
    const addr = r.trim().toLowerCase();
    if (!addr.includes("@")) return true;
    return !own.has(addr) && !ownDomains.has(domainOf(addr));
  });
}

interface Header {
  kind: DraftKind;
  inbox_id: string;
  reply_to?: { inbox_id: string; message_id: string };
  to: string;
  cc: string;
  subject: string;
}

/** Builds the draft's header from (possibly partial) arguments. In `strict`
 *  mode every required part must be valid; otherwise gaps are left empty. The
 *  inbox is checked in both modes. */
function resolveHeader(
  fields: Record<string, unknown>,
  env: DraftEnv,
  strict: boolean,
): { ok: true; header: Header } | { ok: false; message: string } {
  const inboxIds = new Set(env.inboxes.map((i) => i.inbox_id));
  const rt = fields.reply_to && typeof fields.reply_to === "object" ? (fields.reply_to as Record<string, unknown>) : null;
  let replyTo = rt && typeof rt.inbox_id === "string" && typeof rt.message_id === "string" && rt.message_id
    ? { inbox_id: rt.inbox_id, message_id: rt.message_id }
    : null;
  let kind = KINDS.find((k) => k === fields.kind) ?? (replyTo ? "reply" : "new");
  if (kind === "new") replyTo = null;
  else if (!replyTo) replyTo = env.defaultReplyTo;
  if (kind !== "new" && !replyTo) {
    if (strict) return { ok: false, message: "reply_to is required for a reply or forward." };
    kind = "new";
  }

  const inbox = replyTo?.inbox_id ?? (typeof fields.inbox_id === "string" && fields.inbox_id ? fields.inbox_id : env.defaultInboxId);
  if (!inbox || !inboxIds.has(inbox)) return { ok: false, message: "Unknown inbox_id. Use one from the inbox list." };

  const seen = replyTo ? env.mem.seen.get(makeKey(replyTo.inbox_id, replyTo.message_id)) : undefined;
  const to = parseAddresses(typeof fields.to === "string" ? fields.to : "");
  if (!to.list.length && seen?.email && (kind === "reply" || kind === "reply_all")) to.list.push(seen.email);
  const cc = parseAddresses(typeof fields.cc === "string" ? fields.cc : "");
  if (strict && (to.invalid || cc.invalid)) return { ok: false, message: "to and cc must be plain email addresses, comma separated." };
  // A draft may have no recipient yet ("draft an out-of-office message"): the
  // person fills it in, or names one later and edit_draft / request_send set
  // it. request_send is where a recipient becomes mandatory.

  let subject = typeof fields.subject === "string" ? wellFormed(fields.subject).replace(/\s+/g, " ").trim().slice(0, 500) : "";
  if (!subject && seen?.subject && kind !== "new") {
    const bare = seen.subject.replace(/^((re|fwd?):\s*)+/i, "");
    subject = `${kind === "forward" ? "Fwd" : "Re"}: ${bare}`;
  }
  return {
    ok: true,
    header: { kind, inbox_id: inbox, reply_to: replyTo ?? undefined, to: to.list.join(", "), cc: cc.list.join(", "), subject },
  };
}

function fieldsOf(h: Header): DraftFields {
  return { inbox_id: h.inbox_id, to: h.to, subject: h.subject, ...(h.cc ? { cc: h.cc } : {}) };
}
function replyKey(h: { reply_to?: { inbox_id: string; message_id: string } }): MessageKey | undefined {
  return h.reply_to ? makeKey(h.reply_to.inbox_id, h.reply_to.message_id) : undefined;
}

const DRAFT_OK = JSON.stringify({
  ok: true,
  status: "The draft is in the user's compose view. It has NOT been sent. Do not repeat its text in your answer.",
});

/** Streams one write_draft call into the compose view while it is generated. */
export class DraftWriter {
  private readonly args = new JsonArgStream("body");
  private opened = false;
  private blocked = false;
  private streamed = "";
  private header: Header | null = null;
  private call: AssistantToolCall;

  constructor(private readonly env: DraftEnv, readonly callId: string, private readonly messageId: string) {
    this.call = { id: callId, tool: "draft", action: "write", human: "Writing a draft", meta: "", state: "running", keys: [] };
    env.showCall(messageId, this.call);
    env.emit({ type: "status", text: "Writing a draft" });
  }

  /** A chunk of the call's JSON arguments. */
  onDelta(chunk: string): void {
    if (this.blocked) return;
    const delta = this.args.push(chunk);
    if (this.args.started && !this.opened) {
      const resolved = resolveHeader(this.args.completed, this.env, false);
      if (!resolved.ok) {
        // Never open a compose view for an inbox that is not the user's.
        this.blocked = true;
        return;
      }
      this.open(resolved.header);
    }
    if (this.opened && delta) this.write(delta);
  }

  private open(header: Header): void {
    this.header = header;
    this.opened = true;
    const key = replyKey(header);
    const who = key ? this.env.mem.sender(key) : "";
    const first = header.to.split(",")[0]?.trim() ?? "";
    const human = header.kind === "new"
      ? (first ? `Writing an email to ${first}` : "Writing a new email")
      : header.kind === "forward"
      ? (first ? `Writing a forward to ${first}` : "Writing a forward")
      : (who ? `Writing a reply to ${who}` : "Writing a reply");
    this.call = { ...this.call, human, keys: key ? [key] : [], meta: key ? "below" : "" };
    this.env.showCall(this.messageId, this.call);
    this.env.emit({ type: "status", text: human });
    this.env.emit({ ...this.event(header), body_delta: "" });
  }

  private write(delta: string): void {
    const room = this.env.limits.draftBodyMaxChars - this.streamed.length;
    if (room <= 0 || !this.header) return;
    const part = delta.length > room ? delta.slice(0, room) : delta;
    this.streamed += part;
    this.env.emit({ ...this.event(this.header), body_delta: part });
  }

  private event(header: Header): Extract<AssistantEvent, { type: "draft_stream" }> {
    return {
      type: "draft_stream",
      phase: "writing",
      kind: header.kind,
      reply_to: replyKey(header),
      fields: fieldsOf(header),
      call_id: this.callId,
      message_id: this.messageId,
    };
  }

  /** The call's arguments are complete. Returns the draft when it is valid. */
  finish(argumentsJson: string): { outcome: VirtualOutcome; draft: DraftState | null } {
    this.args.end();
    let parsed: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(argumentsJson);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (!parsed) return this.fail("The arguments were not valid JSON. Call write_draft again.");
    const resolved = resolveHeader(parsed, this.env, true);
    if (!resolved.ok) return this.fail(resolved.message);
    const body = wellFormed(typeof parsed.body === "string" ? parsed.body : "").slice(0, this.env.limits.draftBodyMaxChars);
    if (!body.trim()) return this.fail("body is required.");

    const header = resolved.header;
    if (!this.opened) {
      // Nothing was streamed (no argument deltas): show it in one piece.
      this.blocked = false;
      this.open(header);
      this.write(body);
    }
    this.header = header;
    this.env.emit({ ...this.event(header), body, done: true });
    this.call = { ...this.call, state: "done", meta: header.reply_to ? "under the email" : "in the editor" };
    this.env.showCall(this.messageId, this.call);
    return {
      outcome: { content: DRAFT_OK, isError: false },
      draft: { inbox_id: header.inbox_id, kind: header.kind, to: header.to, cc: header.cc, subject: header.subject, body, reply_to: header.reply_to },
    };
  }

  /** The stream ended before the arguments were complete. */
  abandon(meta: string): void {
    this.args.end();
    this.close(meta);
  }

  private fail(message: string): { outcome: VirtualOutcome; draft: null } {
    this.close("failed");
    return { outcome: { content: JSON.stringify({ error: message }), isError: true }, draft: null };
  }

  /** Leaves whatever was written in the editor, no longer "streaming". */
  private close(meta: string): void {
    if (this.opened && this.header) this.env.emit({ ...this.event(this.header), body: this.streamed, done: true });
    this.call = { ...this.call, state: "cancelled", meta };
    this.env.showCall(this.messageId, this.call);
  }
}

/** The header changes a call asks for: only the keys it actually gave. */
function headerChanges(
  parsed: Record<string, unknown> | null,
  current: DraftState,
): { ok: true; to: string; cc: string; subject: string; changed: boolean } | { ok: false; message: string } {
  let { to, cc, subject } = current;
  if (typeof parsed?.to === "string") {
    const list = parseAddresses(parsed.to);
    if (list.invalid) return { ok: false, message: "to must be plain email addresses, comma separated." };
    // An empty `to` never clears recipients the draft already has.
    if (list.list.length) to = list.list.join(", ");
  }
  if (typeof parsed?.cc === "string") {
    const list = parseAddresses(parsed.cc);
    if (list.invalid) return { ok: false, message: "cc must be plain email addresses, comma separated." };
    cc = list.list.join(", ");
  }
  if (typeof parsed?.subject === "string" && parsed.subject.trim()) {
    subject = wellFormed(parsed.subject).replace(/\s+/g, " ").trim().slice(0, 500);
  }
  return { ok: true, to, cc, subject, changed: to !== current.to || cc !== current.cc || subject !== current.subject };
}

function parseObject(argumentsJson: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(argumentsJson || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function editEvent(next: DraftState, callId: string, messageId: string) {
  return {
    type: "draft_stream" as const,
    phase: "editing" as const,
    kind: next.kind,
    reply_to: replyKey(next),
    // An edit always states cc, empty included: the client reads a present-but-empty
    // field as "clear" and an absent one as "unchanged".
    fields: { inbox_id: next.inbox_id, to: next.to, subject: next.subject, cc: next.cc ?? "" },
    call_id: callId,
    message_id: messageId,
  };
}

/**
 * edit_draft: change the current draft's body, recipients or subject.
 *
 * `body`, when given, is the complete new text and is shown as a word diff
 * against `current`. `to`, `cc` and `subject` replace the draft's own. A call
 * may give any of them; a call that gives none is an error for the model.
 */
export async function editDraft(
  env: DraftEnv,
  current: DraftState | null,
  argumentsJson: string,
  callId: string,
  messageId: string,
): Promise<{ outcome: VirtualOutcome; draft: DraftState | null }> {
  const error = (message: string) => ({ outcome: { content: JSON.stringify({ error: message }), isError: true }, draft: null });
  if (!current) return error("There is no current draft. Call write_draft first.");
  const parsed = parseObject(argumentsJson);
  if (!parsed) return error("The arguments were not valid JSON. Call edit_draft again.");
  const givenBody = typeof parsed.body === "string"
    ? wellFormed(parsed.body).slice(0, env.limits.draftBodyMaxChars)
    : "";
  const header = headerChanges(parsed, current);
  if (!header.ok) return error(header.message);
  const bodyChanges = givenBody.trim() !== "" && givenBody !== current.body;
  if (!givenBody.trim() && !header.changed) {
    return error("Nothing to change. Give body (the complete new text), or to, cc or subject.");
  }
  const body = givenBody.trim() ? givenBody : current.body;

  const key = replyKey(current);
  const call: AssistantToolCall = {
    id: callId,
    tool: "draft",
    action: "edit",
    human: "Editing the draft",
    meta: "editing below",
    state: "running",
    keys: key ? [key] : [],
  };
  env.showCall(messageId, call);
  env.emit({ type: "status", text: "Editing the draft" });

  const next: DraftState = { ...current, to: header.to, cc: header.cc, subject: header.subject, body };
  const base = editEvent(next, callId, messageId);
  if (bodyChanges || !header.changed) {
    const segments = diffWords(current.body, body);
    env.emit({ ...base, segments });
    // The diff has to be seen before the final text replaces it.
    await env.sleep(env.limits.editHoldMs);
    env.emit({ ...base, body: applySegments(segments), done: true });
  } else {
    // Recipients or subject only: nothing to diff, the fields change at once.
    env.emit({ ...base, body, done: true });
  }
  env.showCall(messageId, { ...call, state: "done", meta: key ? "under the email" : "in the editor" });
  return {
    outcome: {
      content: JSON.stringify({ ok: true, status: "The draft was updated in the compose view. It has NOT been sent." }),
      isError: false,
    },
    draft: next,
  };
}

/** What request_send tells the model when the draft has nobody to go to. */
export const NO_RECIPIENT_ERROR =
  "The draft has no recipient, so nothing was requested. Do not guess or invent an address. " +
  "If the user named a recipient in this conversation, call request_send again with it in `to`. " +
  "Otherwise ask the user who it should go to and stop.";

/**
 * request_send: validates the current draft and asks the human. Sends nothing.
 *
 * The call may carry `to`, `cc` and `subject`: "send it to maya@x.example"
 * names the recipient in the same breath as the send, and the draft that goes
 * to approval must carry it. They are applied to the draft (and shown in the
 * compose view) before it is validated. `draft` is the draft as it now stands,
 * whether or not the request went through.
 */
export function requestSend(
  env: DraftEnv,
  current: DraftState | null,
  argumentsJson: string,
  callId: string,
  messageId: string,
  approvalId: string,
): { outcome: VirtualOutcome; approved: boolean; draft: DraftState | null; missingRecipient?: boolean } {
  const error = (message: string, draft: DraftState | null = current, missingRecipient = false) => ({
    outcome: { content: JSON.stringify({ error: message }), isError: true },
    approved: false,
    draft,
    ...(missingRecipient ? { missingRecipient } : {}),
  });
  if (!current || !current.body.trim()) return error("There is no draft to send. Call write_draft first.");
  const inbox = env.inboxes.find((i) => i.inbox_id === current.inbox_id);
  if (!inbox) return error("The draft has no valid inbox.");
  const header = headerChanges(parseObject(argumentsJson), current);
  if (!header.ok) return error(`${header.message} Nothing was requested.`);
  const next: DraftState = header.changed
    ? { ...current, to: header.to, cc: header.cc, subject: header.subject }
    : current;
  const to = parseAddresses(next.to);
  const cc = parseAddresses(next.cc);
  if (to.invalid || cc.invalid) {
    return error(
      "The draft's recipients are not valid email addresses. Ask the user for the address, or correct it with `to` on request_send.",
    );
  }
  if (!to.list.length) return error(NO_RECIPIENT_ERROR, current, true);
  // The compose view shows what is about to be approved.
  if (header.changed) env.emit({ ...editEvent(next, callId, messageId), body: next.body, done: true });
  const own = [env.userEmail, inbox.email_address, ...inbox.sender_identities.map((s) => s.email_address)];
  const external = isExternal([...to.list, ...cc.list], own);
  const key = replyKey(next);
  const draft: ApprovalDraft = {
    inbox_id: next.inbox_id,
    to: to.list.join(", "),
    subject: next.subject,
    body: next.body,
    kind: next.kind,
    ...(cc.list.length ? { cc: cc.list.join(", ") } : {}),
    ...(key ? { reply_to: key } : {}),
  };
  env.showCall(messageId, {
    id: callId,
    tool: "email_compose",
    action: "send",
    human: `Send to ${draft.to}`,
    meta: "needs approval",
    state: "waiting",
    keys: key ? [key] : [],
  });
  env.emit({ type: "approval_required", approval_id: approvalId, call_id: callId, draft, external });
  env.emit({ type: "status", text: "Waiting for your approval" });
  return {
    outcome: { content: JSON.stringify({ ok: true, status: "Waiting for the user's approval." }), isError: false },
    approved: true,
    draft: next,
  };
}
