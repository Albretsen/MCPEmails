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

export type CardKind = "outbound_review" | "bulk_plan" | "receipt";

export type CardState =
  | "pending"
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

export interface Receipt {
  outcome:
    | "sent"
    | "scheduled"
    | "rejected"
    | "expired"
    | "decided_elsewhere"
    | "executed"
    | "failed"
    // Local-only outcome: the card cancelled a bulk plan client-side. There is
    // no `bulk_cancel` tool in contract v1 (see report), so nothing is sent to
    // the server and the plan simply expires.
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
  can_decide: boolean;
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
  outbound?: Outbound;
  plan?: Plan;
  receipt?: Receipt;
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
