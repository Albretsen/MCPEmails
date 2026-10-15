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

/**
 * The version a DEFERRED-BODY draft envelope is published under (§8, "Deferred
 * body", 2026-10-13). The server uses it for exactly one shape: a
 * `draft{action:"create"|"reply"|"update"}` result whose `draft.body` is a
 * `DeferredBody`. Everything else, including the inline envelopes `draft_read`
 * and `draft_editor_save` return, is still `SCHEMA_VERSION`.
 *
 * It exists for the bundles that came BEFORE this one, not for this one: a card
 * that knows nothing about `deferred` reads `body.text ?? ""` and would draw an
 * editable empty body over a draft that has one, and an unknown version is the
 * one thing every shipped bundle already refuses to render. This bundle reads
 * both and treats them identically; the body's own `deferred` flag is what it
 * acts on, never the version string.
 */
export const DEFERRED_BODY_SCHEMA_VERSION = "review-card-v2";

/**
 * The key in a tool RESULT's `_meta` that carries a deferred draft body, as
 * `{ text, html, truncated }`. Result `_meta` is forwarded to the view and is
 * not part of what a host shows the model, which is the point of moving the
 * body there. A host is free to drop it; see `store.ts#resolveDeferredBody`.
 */
export const DRAFT_BODY_META_KEY = "mcpemails/draft_body";

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
  /** Never true on a real body. The discriminant against `DeferredBody`. */
  deferred?: false;
  /**
   * Draft editor only, and only on the SAVE that removed the HTML part (`html`
   * is null then too). The card says so in one line rather than silently
   * dropping "Show formatting".
   */
  formatting_removed?: boolean;
}

/**
 * A draft body the server deliberately left OUT of `structuredContent`.
 *
 * `draft{action:"create"|"reply"|"update"}` are model-initiated, and some hosts
 * show `structuredContent` to the model, so those results carry this
 * placeholder and the real body rides in result `_meta[DRAFT_BODY_META_KEY]`.
 * `truncated` already describes the real body, and so does `draft.version`.
 *
 * NOTHING MAY RENDER THIS AS A BODY. `text: null` reads as `""` through every
 * `?? ""` in the components, and an editor mounted on it holds an empty body
 * under the real draft's version, so its first Save writes the blank back.
 * `store.ts` fills it from `_meta` at the boundary when the host delivered it,
 * and App.tsx fetches it with `draft_read` and shows the loading line until
 * then (`store.ts#isBodyDeferred`).
 */
export interface DeferredBody {
  text: null;
  html: null;
  truncated?: boolean;
  deferred: true;
  /** Never on a deferred body: only a save sets it, and a save is not deferred. */
  formatting_removed?: undefined;
}

export type DraftBody = Body | DeferredBody;

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
  /**
   * Present (true) only when the HTML part carries the inbox's formatted
   * signature. Editing the signature LINES replaces it with plain text; a
   * body-only edit keeps it. The card warns before that happens.
   */
  rich?: boolean;
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
   * On an envelope whose body is deferred it still describes the REAL body,
   * not the placeholder, which is what lets the card tell whether the body
   * `draft_read` hands back is the one this envelope was built from.
   *
   * This is what tells the editor whether the text in the box is still
   * describing what the server has. Optional because an envelope restored from
   * storage may predate the field; `DraftEditor#draftVersion` falls back to the
   * content the card itself holds, which is exact but too big to put on a wire.
   */
  version?: string;
  origin?: "create" | "reply" | "update" | "read" | "save";
  /**
   * The id the card ASKED with, present only when it was an older id of this
   * draft that the server's draft lineage resolved to `draft_id`. The card
   * adopts `draft_id` silently; this only confirms the answer is about the
   * draft it asked for (store.ts#acceptRehydration).
   */
  resolved_from?: string;
  /**
   * The draft's lineage revision (server: draft-lineage.ts), present only when
   * the server records one for this draft. Sent back as `base_revision` on
   * every save and send (0 when absent), so a write against a draft that was
   * rewritten since this copy was loaded is refused as `draft_changed` instead
   * of overwriting, or sending, a version the person never saw.
   */
  revision?: number;
  /**
   * When the draft was last SAVED. On a write it is the time of that write; on
   * a read (`draft_read`, Refresh) it is the last real save, never the time of
   * the read, and null when nobody recorded one. (Until 2026-10-13 every path
   * stamped the response time.) Still not a version: `version` says whether
   * anything changed. store.ts#isReplayedDraft reads its age for one purpose.
   */
  last_saved_at?: string | null;
  /** "user" only when the last write was `draft_editor_save`; null when not known. */
  last_saved_by?: "agent" | "user" | null;
  identity: Identity;
  recipients?: DraftRecipients;
  subject?: string;
  /** May arrive as a `DeferredBody`; no component is handed one. */
  body?: DraftBody;
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
  return v === SCHEMA_VERSION || v === DEFERRED_BODY_SCHEMA_VERSION;
}
