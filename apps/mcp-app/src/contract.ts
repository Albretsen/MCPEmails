// ---------------------------------------------------------------------------
// Wire types for docs/mcp-apps/contract.md (v1).
//
// These mirror the contract exactly. The contract is owned by the orchestrating
// session; if a shape needs to change, report it, do not fork it here.
//
// EVERYTHING IN HERE IS HOSTILE INPUT. Subjects, sender display names,
// attachment filenames and sample rows all originate from email. Nothing is
// rendered via innerHTML; HTML bodies go through sanitize.ts first.
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "review-card-v1";

export type CardKind =
  | "outbound_review"
  | "bulk_plan"
  | "receipt"
  | "draft_editor";

export type CardState =
  | "pending"
  | "editing"
  | "sent"
  | "scheduled"
  | "rejected"
  | "expired"
  | "decided_elsewhere"
  | "executed"
  | "error";

export interface Identity {
  inbox_id: string;
  email_address: string;
  display_name?: string | null;
  provider: "gmail" | "outlook" | "imap";
  service?: string | null;
}

export interface Recipients {
  to: string[];
  cc: string[];
  bcc_count: number;
}

export interface Body {
  text: string;
  html?: string | null;
  truncated?: boolean;
}

export interface Attachment {
  filename: string;
  size_bytes: number;
  mime_type: string;
}

export interface Signature {
  will_append: boolean;
  source?: "manual" | "gmail_import" | null;
  preview_text?: string | null;
}

export interface RequestedBy {
  api_key_name?: string | null;
  client_name?: string | null;
}

export interface Outbound {
  approval_id: string;
  operation:
    | "email_send"
    | "email_reply"
    | "email_forward"
    | "draft_send"
    | "schedule_create";
  created_at: string;
  expires_at: string;
  send_at?: string | null;
  review_url: string;
  identity: Identity;
  recipients: Recipients;
  subject: string;
  body: Body;
  attachments?: Attachment[];
  signature?: Signature | null;
  requested_by?: RequestedBy | null;
}

export interface PlanScope {
  kind: "explicit_ids" | "search";
  description: string;
  folder?: string | null;
  destination?: string | null;
}

export interface PlanSample {
  from: string;
  subject: string;
  date: string;
}

export interface Plan {
  plan_id: string;
  operation: "email_delete" | "email_organize";
  action:
    | "delete_batch"
    | "search_and_delete"
    | "move_batch"
    | "search_and_move";
  expires_at: string;
  inbox: { inbox_id: string; email_address: string; provider: string };
  scope: PlanScope;
  match_count: number;
  sample?: PlanSample[];
  sample_truncated?: boolean;
}

/**
 * §8 `draft_editor`. Every field except `draft_id` is treated as absent-by-
 * default in the components: the envelope is built by a server path that is
 * allowed to degrade to today's payload, and a card that crashes on a missing
 * `recipients` would turn a working draft into a blank frame.
 */
export interface DraftRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface DraftSignature {
  /** Whether the stored text already carries the signature. Display only. */
  embedded: boolean;
}

/**
 * The message being replied to. §8 lists message_id, subject and from;
 * CONCEPT §7 also wants a date on the collapsed line, so `date` is accepted
 * and rendered when present rather than required.
 */
export interface InReplyTo {
  message_id?: string | null;
  subject?: string | null;
  from?: string | null;
  date?: string | null;
}

export interface DraftEditorData {
  /**
   * The CURRENT id. On IMAP it changes on every save, so the card adopts the
   * id from every server response and never reuses the one it was mounted
   * with. See `id_is_stable`.
   */
  draft_id: string;
  id_is_stable?: boolean;
  /**
   * An opaque id for the CONTENT of this draft, server-authored
   * (`mcp-app-drafts.ts#draftContentVersion`). Equal versions mean equal
   * content. Compared only against another `version`, never parsed, never
   * rendered, never sent back.
   *
   * This is what tells the editor whether the text in the box is still
   * describing what the server has. Optional because an envelope restored from
   * storage may predate the field; `DraftEditor#draftVersion` falls back to the
   * content the card itself holds, which is exact but too big to put on a wire.
   */
  version?: string;
  origin?: "create" | "reply" | "update" | "read" | "save";
  /**
   * NOT a modification time. Every server path stamps this with the clock at
   * RESPONSE time, so two reads of an untouched draft differ in it. Render it,
   * do not reason with it — `version` is the field that says whether anything
   * changed.
   */
  last_saved_at?: string | null;
  /** "user" only when the last write was `draft_editor_save`. */
  last_saved_by?: "agent" | "user" | null;
  identity: Identity;
  recipients?: DraftRecipients;
  subject?: string;
  body?: Body;
  /** Display only: the card cannot add or remove attachments. */
  attachments?: Attachment[];
  signature?: DraftSignature | null;
  in_reply_to?: InReplyTo | null;
  /** Key has send:email AND the draft has at least one recipient. */
  can_send?: boolean;
}

export interface Receipt {
  outcome:
    | "sent"
    | "scheduled"
    | "discarded"
    | "rejected"
    | "expired"
    | "decided_elsewhere"
    | "executed"
    | "failed"
    // Local-only outcome: the card cancelled a bulk plan client-side, so
    // nothing is sent to the server and the plan expires on its own after 15
    // minutes.
    //
    // Corrected 2026-09-16: this used to say "there is no `bulk_cancel` tool in
    // contract v1". There is — mcp-app-bulk.ts declares it, taking only
    // `plan_id` — and the comment predated it. The card still cancels locally;
    // whether it should instead record the decision server-side is a separate
    // question from whether the tool exists, and is open.
    | "cancelled";
  headline: string;
  detail?: string | null;
  affected_count?: number | null;
  dashboard_url?: string | null;
  error_code?: string | null;
}

export interface Provider {
  label: string;
  route: string;
  caveats?: string[];
}

export interface Actor {
  /** Outbound / bulk cards. Absent on a draft_editor envelope. */
  can_decide?: boolean;
  /** draft_editor. `false` with `reason` viewer_role | wrong_workspace | not_found. */
  can_edit?: boolean;
  reason?: string | null;
}

export interface Envelope {
  schema_version: string;
  card: CardKind;
  /**
   * Absolute dashboard URL, server-authored from its APP_URL. Envelope-level so
   * it survives the case where the rest of the envelope cannot be read — an
   * unsupported schema_version is exactly when we still want to offer a way out,
   * and a receipt-level field would be unreachable there.
   */
  dashboard_url?: string | null;
  state: CardState;
  /**
   * Internal only, `true` or absent. Turns on the protocol diagnostics line.
   *
   * Three files called that line "INTERNAL v1 ONLY" while App.tsx rendered it
   * unconditionally, on every card kind. The customer-facing opt-ins that
   * produce a card (`inboxes.send_approval_required`, `bulk_review_mode =
   * 'plan'`) are not an internal rollout flag, so 7 non-internal workspaces
   * were reading our protocol trivia under their own send approvals.
   *
   * The card bundle is static, identical for every workspace, and has no server
   * round trip of its own before it renders, so the only thing that can carry a
   * per-workspace "this is us" signal is the envelope.
   *
   * As built (2026-09-17), and NOT what the proposal above it said: the server
   * reads its OWN column, `workspaces.card_diagnostics`, not the draft editor's
   * rollout flag. Reusing that one would have turned the line on for every
   * workspace the editor ever reaches, which is worse than leaving it off. The
   * stamp is one call at the end of `tools/call` dispatch
   * (`supabase/functions/mcp-server/card-diagnostics.ts`), not an argument on
   * the six envelope builders, so a new card kind is gated the day it ships.
   *
   * `true` and nothing else turns it on (diagnostics.ts#diagnosticsEnabled).
   */
  diagnostics?: boolean;
  outbound?: Outbound;
  plan?: Plan;
  /**
   * §8's draft payload on a `draft_editor` card.
   *
   * It also rides along on a `card: "receipt"` envelope whose outcome is `sent`
   * or `scheduled`, and that one is CLIENT-AUTHORED: the server sends no draft
   * on a receipt, and `store.ts#carrySentDraft` moves the copy the card was
   * already showing across so that pressing Send does not erase the message
   * from the screen. Read-only from that moment on — the draft is gone at the
   * provider and there is nothing left to save it to.
   */
  draft?: DraftEditorData;
  receipt?: Receipt;
  /**
   * Not an envelope field: a published key of the `draft{action:"send"}`
   * payload, which §8 merges with the receipt envelope at the top level, so it
   * arrives here for free. Declared rather than cast at the use site because the
   * merge is a documented contract, and read defensively because every other
   * path that produces a receipt sends none.
   *
   * It is the one timestamp the card can format itself. The server has no
   * timezone to render a send time in, which is why its `detail` no longer
   * carries one.
   */
  sent_at?: string | null;
  provider?: Provider;
  actor?: Actor;
}

/**
 * Structural check only — enough to decide whether we can render at all.
 * Field-level defensiveness lives in the components (every optional is
 * treated as absent-by-default).
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.schema_version === "string" && typeof v.card === "string";
}

export function isSupportedVersion(v: string): boolean {
  return v === SCHEMA_VERSION;
}
