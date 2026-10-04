/* The event stream the assistant emits. Server-side copy of `AssistantEvent`
 * in apps/client/src/api/assistant-api.ts: same names, same shapes. Fields
 * marked ADDITION do not exist in the client's type yet; they are all optional
 * for the client's reducer, which ignores unknown fields.
 */

/** `${inbox_id}:${message_id}`, split on the FIRST colon (same as the client). */
export type MessageKey = string;

export type FolderRole = "inbox" | "starred" | "drafts" | "scheduled" | "sent" | "archive" | "trash" | "spam";

export type FolderRef = { role: FolderRole } | { inbox_id: string; folder_id: string } | { name: string };

export interface MessageFlags {
  read?: boolean;
  starred?: boolean;
}

/** Subset of the client's ToolName the assistant can produce. Virtual tools
 *  are shown as `draft` (write/edit) and `email_compose` (held send). */
export type ToolName =
  | "email_read"
  | "email_search"
  | "email_organize"
  | "email_delete"
  | "draft"
  | "draft_list"
  | "email_compose"
  | "folder_list"
  | "contact_search";

export type ToolCallState = "running" | "done" | "waiting" | "held" | "cancelled";

export interface AssistantToolCall {
  id: string;
  tool: ToolName;
  action?: string;
  human: string;
  meta?: string;
  state: ToolCallState;
  keys: MessageKey[];
  folder?: FolderRef;
}

export type MailEffectKind = "read" | "moved" | "flagged" | "drafted" | "sent";

export interface MailEffect {
  kind: MailEffectKind;
  keys: MessageKey[];
  to?: FolderRef;
  from?: FolderRef;
  flags?: MessageFlags;
  call_id: string;
  /** ADDITION. Parallel to `keys`: the key each message has AFTER a move
   *  (IMAP ids change per folder). Equal to the old key when the provider
   *  reported no new id. Undo must address the message by this key. */
  new_keys?: MessageKey[];
}

export interface DraftFields {
  inbox_id?: string;
  to: string;
  subject: string;
  /** ADDITION. Comma separated, like `to`. */
  cc?: string;
}

export type DraftKind = "reply" | "reply_all" | "new" | "forward";

export type DiffSegment = { k: "keep" | "del" | "ins"; t: string };

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
  /** ADDITION. */
  cc?: string;
  /** ADDITION. Which mail op the client must use when the human approves. */
  kind?: DraftKind;
}

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number;
  model: string;
  rounds: number;
}

/** Why a run ended without the model finishing on its own. */
export type StopReason = "max_rounds" | "timeout" | "token_ceiling" | "output_limit";

export type ErrorCode =
  | "allowance_exhausted"
  | "invalid_request"
  | "provider_error"
  | "rate_limited"
  | "timeout"
  | "not_configured";

export type AssistantEvent =
  | { type: "run_started"; run_id: string }
  | { type: "status"; text: string; progress?: { i: number; n: number } }
  | { type: "text_delta"; message_id: string; delta: string; done?: boolean }
  | { type: "tool_call"; message_id: string; call: AssistantToolCall }
  | { type: "mail_effect"; effect: MailEffect }
  | {
    type: "draft_stream";
    phase: "writing" | "editing";
    reply_to?: MessageKey;
    fields: DraftFields;
    body_delta?: string;
    segments?: DiffSegment[];
    body?: string;
    call_id?: string;
    message_id?: string;
    done?: boolean;
    /** ADDITION. */
    kind?: DraftKind;
  }
  | { type: "approval_required"; approval_id: string; call_id: string; draft: ApprovalDraft; external: boolean }
  | { type: "chips"; message_id: string; chips: AssistantChip[] }
  | {
    type: "done";
    summary?: { text: string; undoable: boolean };
    /** ADDITION. Opaque: send it back as `conversation` on the next request. */
    conversation?: unknown;
    /** ADDITION. */
    usage?: RunUsage;
    /** ADDITION. Present when a limit ended the run. */
    stopped?: StopReason;
  }
  | {
    type: "error";
    message: string;
    /** ADDITION. */
    code?: ErrorCode;
    /** ADDITION. */
    retryable?: boolean;
    /** ADDITION. With `allowance_exhausted`: ISO 8601 date the allowance resets. */
    resets_at?: string;
  };

export type Emit = (event: AssistantEvent) => void;

export function makeKey(inbox_id: string, message_id: string): MessageKey {
  return `${inbox_id}:${message_id}`;
}

export function parseKey(key: MessageKey): { inbox_id: string; message_id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0 || i >= key.length - 1) return null;
  return { inbox_id: key.slice(0, i), message_id: key.slice(i + 1) };
}
