/* Assistant contract: one request in, an abortable stream of events out.
 *
 * The transport is the only thing that knows where the assistant runs (a
 * scripted mock today, the server's agent loop over the MCP tool layer later).
 * The client never executes tools itself: it renders `tool_call` events and
 * mirrors `mail_effect` events into its own list cache, so everything the
 * assistant does is visible in the inbox as it happens.
 *
 * The generic reducer that applies these events lives in
 * `state/assistant-store.ts` (`applyAssistantEvent`).
 */

import type { FolderRef, MessageFlags, MessageKey } from "./types";

/** Tools of the MCP server (the assistant uses the same layer as connectors). */
export type ToolName =
  | "email_read"
  | "email_search"
  | "email_organize"
  | "email_delete"
  | "email_search_and_move"
  | "draft"
  | "draft_list"
  | "email_compose"
  | "folder"
  | "folder_list"
  | "inbox_list"
  | "schedule"
  | "schedule_list"
  | "contact_search";

/** The compose state the assistant may be asked to edit or send. */
export type DraftKind = "reply" | "reply_all" | "new" | "forward";

export interface AssistantDraftContext {
  inbox_id: string;
  kind?: DraftKind;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  reply_to?: MessageKey;
  draft_id?: string;
}

/** What happened, client side, to something the assistant asked for. Sent
 *  with the next run so the assistant knows (the server keeps no state). */
export type AssistantContextNote = {
  type: "approval";
  approval_id: string;
  decision: "approved" | "rejected" | "edited";
};

export interface AssistantRequest {
  text: string;
  /** Emails attached as chips. Empty = the request is about all mail.
   *  On the wire (HTTP) each key goes out as `{ inbox_id, message_id, folder? }`:
   *  `folder` is where the message is now, so a move of it can be undone. */
  context: { keys: MessageKey[]; notes?: AssistantContextNote[]; timezone?: string };
  conversation_id: string;
  /** Opaque state from the previous run's `done` event (HTTP transport: the
   *  server is stateless). Null or absent on the first turn. */
  conversation?: unknown;
  /** Current compose state, sent when the user may be asking for edits. */
  draft?: AssistantDraftContext;
  /** Set when a suggestion card or quick action started the run. */
  intent?: string;
}

export type ToolCallState = "running" | "done" | "waiting" | "held" | "cancelled";

export interface AssistantToolCall {
  id: string;
  tool: ToolName;
  action?: string;
  /** Sentence shown in the transcript: "Reading Maya Chen · Q4 renewal". */
  human: string;
  /** Short trailing note: "6 found", "needs approval", "paused". */
  meta?: string;
  /** running: in flight. waiting: needs the user's approval. held: paused
   *  because the pointer is on the list. done / cancelled: finished. */
  state: ToolCallState;
  /** Emails this call touches. Drives the row highlight and the two-way link. */
  keys: MessageKey[];
  folder?: FolderRef;
}

export type MailEffectKind = "read" | "moved" | "flagged" | "drafted" | "sent";

/** What the client mirrors into the list. `read` means "the assistant read it"
 *  (a highlight), NOT "marked as read": that is `flagged` with `flags.read`. */
export interface MailEffect {
  kind: MailEffectKind;
  keys: MessageKey[];
  to?: FolderRef;
  from?: FolderRef;
  flags?: MessageFlags;
  /** `moved`: the keys the messages have NOW, parallel to `keys` (IMAP ids
   *  change per folder). Absent when the ids did not change. */
  new_keys?: MessageKey[];
  call_id: string;
}

/** The draft's header as a `draft_stream` event carries it.
 *  phase "writing": the header as far as it has streamed in; an empty field
 *  means "not there yet".
 *  phase "editing": the header as it stands after the edit. A field that is
 *  PRESENT is taken as it is, the empty string included (`cc: ""` clears the
 *  Cc line); a field that is ABSENT was not touched. */
export interface DraftFields {
  inbox_id?: string;
  to: string;
  subject: string;
  /** Comma separated, like `to`. */
  cc?: string;
}

export type DiffSegment = { k: "keep" | "del" | "ins"; t: string };

export interface AssistantCard {
  id: string;
  /** lucide icon name in kebab case, e.g. "reply", "receipt", "newspaper". */
  icon: string;
  title: string;
  sub: string;
  /** Button label. */
  action: string;
  /** What to run when the button is pressed. */
  prompt: string;
  intent?: string;
  /** True when pressing it does not use an allowance action. */
  free?: boolean;
}

export type AssistantChip =
  | { kind: "email"; key: MessageKey; label?: string; sub?: string }
  | { kind: "folder"; folder: FolderRef; label?: string; sub?: string }
  | { kind: "draft"; label?: string; sub?: string };

export interface ApprovalDraft {
  inbox_id: string;
  to: string;
  subject: string;
  body: string;
  reply_to?: MessageKey;
  cc?: string;
  /** CLIENT SIDE ONLY. The server knows nothing of Bcc (it ignores the one
   *  sent with the request's `draft`), so its approval never carries one. The
   *  transport puts back the Bcc the person had typed on the draft the run
   *  was started with, so approving sends to them too. */
  bcc?: string;
  /** How the message goes out when the human approves. */
  kind?: DraftKind;
}

export type AssistantEvent =
  /** First event of every run. `run_id` is what `undo` takes. */
  | { type: "run_started"; run_id: string }
  | { type: "status"; text: string; progress?: { i: number; n: number } }
  /** `done` marks the end of this message's text (the caret stops). */
  | { type: "text_delta"; message_id: string; delta: string; done?: boolean }
  /** Re-emitted with the same `call.id` to update its state. */
  | { type: "tool_call"; message_id: string; call: AssistantToolCall }
  | { type: "mail_effect"; effect: MailEffect }
  /** A short tag on rows, e.g. "needs reply". `label: null` clears it. */
  | { type: "row_label"; keys: MessageKey[]; label: string | null }
  /** Streams a draft into the normal compose view.
   *  writing: `body_delta` chunks append. editing: `segments` replace the view
   *  (word diff against the previous body). `done` carries the final `body`. */
  | {
      type: "draft_stream";
      phase: "writing" | "editing";
      reply_to?: MessageKey;
      fields: DraftFields;
      body_delta?: string;
      segments?: DiffSegment[];
      body?: string;
      /** With `done`: the id the draft was saved under, if the assistant saved it. */
      draft_id?: string;
      call_id?: string;
      message_id?: string;
      done?: boolean;
      kind?: DraftKind;
    }
  /** Fail closed: an unanswered approval is a denial. */
  | { type: "approval_required"; approval_id: string; call_id: string; draft: ApprovalDraft; external: boolean }
  | { type: "cards"; message_id: string; cards: AssistantCard[] }
  | { type: "chips"; message_id: string; chips: AssistantChip[] }
  /** The last event of a run that started working (also after `error`, so the
   *  conversation and the undo summary of what already changed are kept).
   *  `conversation`: opaque state to send back with the next run.
   *  `stopped`: a limit ended the run (`max_rounds`, `timeout`,
   *  `token_ceiling`, `output_limit`); the engine has already said so in a
   *  text message of its own. */
  | { type: "done"; summary?: { text: string; undoable: boolean }; conversation?: unknown; usage?: RunUsage; stopped?: string }
  /** `code` is the API error code when there is one (`allowance_exhausted`...).
   *  `retryable`: asking the same thing again may work. `resets_at`: with
   *  `allowance_exhausted`, when the allowance resets. A run that had started
   *  working still ends with `done` after this; one refused at the door
   *  (allowance, not configured) ends here. */
  | { type: "error"; message: string; code?: string; retryable?: boolean; resets_at?: string };

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  model: string;
  rounds: number;
}

export type ApprovalDecision = "approve" | "reject" | "edit";

export interface AssistantTransport {
  /** True when a run ENDS with `approval_required` and the approval is answered
   *  afterwards (HTTP). False / absent when the run stays open while it waits
   *  (mock), where an approval still unanswered at the end is a denial. */
  readonly approvalsOutliveRun?: boolean;
  /** Abort via `opts.signal`: the iterator must end promptly and stop acting. */
  run(req: AssistantRequest, opts: { signal: AbortSignal }): AsyncIterable<AssistantEvent>;
  resolveApproval(approval_id: string, decision: ApprovalDecision): Promise<void>;
  /** Reverts the mail effects of one run. */
  undo(run_id: string): Promise<void>;
}

const TOOL_VERB: Partial<Record<ToolName, string>> = {
  email_read: "Reading",
  email_search: "Searching",
  email_organize: "Moving",
  email_search_and_move: "Moving",
  email_delete: "Deleting",
  draft: "Drafting",
  email_compose: "Sending",
};

/** Row tag while a call is touching an email ("Reading", "Moving", ...). */
export function toolTag(tool: ToolName, state: ToolCallState): string {
  if (tool === "email_compose" && state === "waiting") return "Awaiting approval";
  return TOOL_VERB[tool] ?? "Working";
}

/** lucide icon name (kebab case) for a tool. */
export function toolIcon(tool: ToolName): string {
  switch (tool) {
    case "email_read":
      return "eye";
    case "email_organize":
    case "email_search_and_move":
      return "folder-input";
    case "draft":
      return "file-pen";
    case "email_compose":
      return "shield-alert";
    case "email_search":
      return "search";
    case "email_delete":
      return "trash-2";
    default:
      return "sparkles";
  }
}
