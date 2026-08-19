// ---------------------------------------------------------------------------
// Unattended scheduled triage ("Automations") - the engine.
//
// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER PATH IN THE SERVER
// -------------------------------------------------------------
// Every other mailbox action originates in a live MCP conversation, with a
// model that just read the user's message and a client that can raise a
// confirmation prompt. This one runs on a cron, with nobody watching. Three
// consequences shape the whole file:
//
//   1. NO LLM IS IN THE LOOP, ANYWHERE. A rule is a stored NormalizedSearch
//      plus one tagged action from a closed set. Email content is MATCHED, never
//      INTERPRETED. `renderTriageTemplate` below is the only place message-derived
//      text enters an outgoing artifact, and it substitutes four whitelisted
//      placeholders and nothing else. There is no expression evaluation, and
//      message BODIES are never interpolated at all: a body is the single most
//      attacker-controlled field in the product, and an unattended runner that
//      copied one into a reply would be a prompt-injection amplifier with no
//      human between the injection and the send.
//
//   2. EVERY ACTION IS REVERSIBLE OR HUMAN-GATED. move / label / mark_read are
//      reversible and record `undo_state`. forward is ALWAYS routed through
//      send_approvals, regardless of `inboxes.send_approval_required`, because
//      the inbox-level switch expresses "a human is watching this mailbox's
//      sends", which is exactly the assumption an unattended runner breaks.
//      draft_reply creates a draft and never sends it. DELETE IS NOT AN
//      AVAILABLE ACTION and is rejected at validation time, not merely absent.
//
//   3. RETRIES ARE ROUTINE, NOT EXCEPTIONAL. A cron-driven runner overlaps
//      itself, gets re-dispatched, and dies mid-run. `triage_seen_messages` is
//      the primitive that makes that safe: a message is CLAIMED before it is
//      acted on, so a second run cannot move the same mail twice.
//
// SHAPE OF THIS MODULE
// --------------------
// Dependencies are injected (`TriageDeps`) rather than imported, the same
// pattern as mcp-app-bulk.ts and mcp-app-approvals.ts. That is not ceremony:
// the provider seams live in index.ts, and injecting them means (a) this file
// is unit-testable without a Supabase client or a mailbox, and (b) the runner
// physically cannot become a second way to move or send mail, because it has no
// provider code of its own.
//
// Related: supabase/migrations/20260819170000_create_triage_automations.sql
// (the tables and the reasoning behind each column),
// 20260819190000_schedule_triage_dispatch.sql (the cron that drives this).
// ---------------------------------------------------------------------------

import { neutralizeMaybe, neutralizeText } from "./text-safety.ts";
import type { NormalizedSearch } from "./search-translate.ts";

// ---------------------------------------------------------------------------
// Budgets and constants
// ---------------------------------------------------------------------------

/**
 * Rules claimed per invocation. pg_cron re-invokes every minute, and the
 * shortest cadence on the ladder is 15 minutes, so a backlog drains long before
 * any rule can miss its next slot. Small on purpose: one invocation holding
 * leases on hundreds of rules is one crash away from a large stale-lease sweep.
 */
export const MAX_RULES_PER_INVOCATION = 20;

/**
 * Hard wall-clock budget. The Edge Function has its own execution ceiling, and
 * being killed mid-rule is precisely the situation that produces a stale lease
 * and a fail-forward run. Returning cleanly at 40 seconds trades a little
 * throughput for never being the cause of that.
 */
export const TRIAGE_TIME_BUDGET_MS = 40_000;

/**
 * A lease older than this belongs to an invocation that died.
 *
 * The reclaim RELEASES the lease but marks the open run `failed`; it never
 * re-runs it. This is the settled rule across the whole system: a stale
 * 'sending' scheduled_send becomes 'error' rather than being re-sent, and a
 * stuck 'executing' bulk_plan is likewise failed forward. The reasoning is the
 * same every time: a partially applied run may already have moved half the
 * matched mail, and the ledger only protects the messages it got to. Re-running
 * would be safe for those and wrong for anything the crash interrupted between
 * the provider call and the ledger write.
 */
export const TRIAGE_STALE_LEASE_MS = 10 * 60 * 1000;

/** The cadence ladder. A free integer invites a 1-minute rule that rate-limits a provider. */
export const TRIAGE_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

/** Per-run blast radius bounds, mirroring the CHECK on triage_rules. */
export const TRIAGE_MIN_MESSAGES_PER_RUN = 1;
export const TRIAGE_MAX_MESSAGES_PER_RUN = 200;

/** Template length cap. Matches the dashboard's editor limit. */
export const TRIAGE_MAX_TEMPLATE_CHARS = 5000;

/** Forward fan-out cap. An unattended rule is not a mailing list. */
export const TRIAGE_MAX_FORWARD_RECIPIENTS = 10;

/**
 * Cap on the optional introductory note a forward prepends.
 *
 * Much smaller than the draft_reply template cap. A note is a one-line
 * explanation for the person receiving the forward ("auto-forwarded invoice"),
 * not a composed message, and it is the only free text an automation puts in
 * front of mail leaving the account.
 */
export const TRIAGE_MAX_FORWARD_NOTE_CHARS = 500;

/** Consecutive failed runs before the rule disables itself. */
export const TRIAGE_MAX_CONSECUTIVE_FAILURES = 5;

/** `subject_redacted` / `sender_redacted` truncation, matching the column comments. */
export const TRIAGE_REDACTED_MAX_CHARS = 120;

/**
 * The operation names an automation writes to `activity_log` and `action_usage`.
 *
 * Distinct from the interactive tool names on purpose: an automated move and a
 * user-driven move are the same mailbox effect but very different facts about
 * the account, and an operator reading the audit log should not have to infer
 * which happened. index.ts adds these to BILLABLE_TOOL_NAMES, which closes the
 * standing hole where the /dispatch path wrote no audit rows at all.
 */
export const TRIAGE_OPERATION_NAMES = [
  "triage_move",
  "triage_label",
  "triage_mark_read",
  "triage_forward",
  "triage_draft_reply",
] as const;

export type TriageOperationName = typeof TRIAGE_OPERATION_NAMES[number];

// ---------------------------------------------------------------------------
// The action shapes
// ---------------------------------------------------------------------------

export type TriageAction =
  | { type: "move"; folder: string }
  | { type: "label"; label: string }
  | { type: "mark_read" }
  | { type: "forward"; to: string[]; note?: string }
  | { type: "draft_reply"; template: string };

export type TriageActionType = TriageAction["type"];

/** The closed set. Adding to it is a deliberate act, not a shape inference. */
export const TRIAGE_ACTION_TYPES: TriageActionType[] = [
  "move",
  "label",
  "mark_read",
  "forward",
  "draft_reply",
];

/**
 * Action names that MUST be refused, spelled out rather than left to fall
 * through the whitelist.
 *
 * A whitelist alone already rejects them. This list exists so the refusal is a
 * NAMED, TESTED behaviour with an error the user can understand, instead of a
 * generic "unknown action type". Deletion is the one mailbox operation with no
 * undo and no approval gate that could make it safe unattended, so the product
 * commitment is that Automations cannot delete mail. A future contributor
 * adding "delete" to TRIAGE_ACTION_TYPES has to delete this list first, which is
 * the point.
 */
export const TRIAGE_FORBIDDEN_ACTION_TYPES = [
  "delete",
  "delete_batch",
  "trash",
  "remove",
  "purge",
  "expunge",
  "destroy",
  "permanent_delete",
  "search_and_delete",
  "empty_trash",
  // Kept in step with DELETE_SHAPED in apps/web/src/lib/automations/rules.ts.
  "erase",
];

/**
 * Move destinations that are refused because moving mail there is deletion
 * wearing a different hat.
 *
 * `TRIAGE_FORBIDDEN_ACTION_TYPES` blocks an action literally named "delete",
 * but every provider also auto-purges its trash folder on a timer, so a rule
 * with {type:'move', folder:'Trash'} is an unattended delete with a 30-day
 * fuse. We advertise that Automations never delete mail, and that claim has to
 * survive somebody typing "Trash" into the folder box.
 *
 * Matching is on the normalized leaf name, so "Trash", "[Gmail]/Trash",
 * "INBOX.Trash" and "Deleted Items" are all caught. Moving mail OUT of trash is
 * unaffected: only the destination is checked.
 */
export const TRIAGE_FORBIDDEN_MOVE_DESTINATIONS = [
  "trash",
  "bin",
  "deleted",
  "deleted items",
  "deleted messages",
  "junk",
  "spam",
];

/**
 * Reduce a user-supplied folder path to its comparable leaf name.
 * "[Gmail]/Trash" -> "trash";  "INBOX.Deleted Items" -> "deleted items".
 */
export function triageFolderLeaf(folder: string): string {
  const leaf = folder.split(/[/.\\]/).filter(Boolean).pop() ?? folder;
  return leaf.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The scope a key must hold for each action, identical to the interactive tool. */
export const TRIAGE_ACTION_SCOPES: Record<TriageActionType, string> = {
  move: "manage:folders",
  label: "manage:folders",
  mark_read: "manage:folders",
  // forward stops at an approval row and never transmits from here, but the key
  // must still hold send:email: the approval, once a human accepts it, becomes a
  // real send, and a key that could not have sent must not be able to queue one.
  forward: "send:email",
  draft_reply: "manage:drafts",
};

/** Which audit/meter operation name each action writes. */
export const TRIAGE_ACTION_OPERATIONS: Record<TriageActionType, TriageOperationName> = {
  move: "triage_move",
  label: "triage_label",
  mark_read: "triage_mark_read",
  forward: "triage_forward",
  draft_reply: "triage_draft_reply",
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type TriageValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail<T>(error: string): TriageValidation<T> {
  return { ok: false, error };
}

/** RFC-shaped enough to catch typos without rejecting legitimate addresses. */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * The NormalizedSearch fields a stored filter may carry.
 *
 * `raw` is included, and reluctantly so. It is a provider-native query string
 * passed through verbatim, i.e. a second dialect nothing validates, which is a
 * defensible trade for an interactive call a human just typed and a much worse
 * one for a query that re-executes unattended every fifteen minutes for months.
 * It is here because apps/web/src/lib/automations/rules.ts already accepts it,
 * and a filter the dashboard will happily save but the runner refuses to run is
 * a worse failure than a permissive field: the user gets a rule that silently
 * never works. If it is ever dropped, drop it on BOTH sides in the same change.
 *
 * The mitigation is the same either way: `raw` is length-capped like every other
 * term, neutralized, and translated by search-translate.ts, which never lets it
 * become anything but a search.
 */
const ALLOWED_FILTER_STRING_FIELDS = ["from", "to", "cc", "subject", "body", "text", "raw"] as const;
const ALLOWED_FILTER_BOOL_FIELDS = ["unread", "has_attachment", "flagged"] as const;
const ALLOWED_FILTER_DATE_FIELDS = ["since", "before"] as const;

/** Longest a single filter term may be. Long enough for a real subject line. */
const MAX_FILTER_TERM_CHARS = 500;

/**
 * Validates a stored filter as a NormalizedSearch.
 *
 * A filter that matches everything is refused: an empty filter on a 15-minute
 * cadence is a rule that will move the entire mailbox, and it is far more
 * likely to be a mistake than an intent.
 */
export function validateTriageFilter(raw: unknown): TriageValidation<NormalizedSearch> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("filter must be an object of search criteria.");
  }
  const input = raw as Record<string, unknown>;
  const out: NormalizedSearch = {};
  let criteria = 0;

  for (const key of Object.keys(input)) {
    const known =
      (ALLOWED_FILTER_STRING_FIELDS as readonly string[]).includes(key) ||
      (ALLOWED_FILTER_BOOL_FIELDS as readonly string[]).includes(key) ||
      (ALLOWED_FILTER_DATE_FIELDS as readonly string[]).includes(key);
    if (!known) {
      return fail(
        `filter: unsupported field '${neutralizeText(String(key)).slice(0, 40)}'. ` +
          `Allowed: ${[...ALLOWED_FILTER_STRING_FIELDS, ...ALLOWED_FILTER_BOOL_FIELDS, ...ALLOWED_FILTER_DATE_FIELDS].join(", ")}. ` +
          "Provider-native 'raw' queries are not accepted for automations.",
      );
    }
  }

  for (const key of ALLOWED_FILTER_STRING_FIELDS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return fail(`filter.${key} must be a string.`);
    const trimmed = neutralizeText(value).trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_FILTER_TERM_CHARS) {
      return fail(`filter.${key} must be at most ${MAX_FILTER_TERM_CHARS} characters.`);
    }
    (out as Record<string, unknown>)[key] = trimmed;
    criteria++;
  }

  for (const key of ALLOWED_FILTER_BOOL_FIELDS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") return fail(`filter.${key} must be a boolean.`);
    (out as Record<string, unknown>)[key] = value;
    criteria++;
  }

  for (const key of ALLOWED_FILTER_DATE_FIELDS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      return fail(`filter.${key} must be an ISO 8601 date or datetime.`);
    }
    (out as Record<string, unknown>)[key] = value;
    criteria++;
  }

  if (criteria === 0) {
    return fail(
      "filter must contain at least one criterion. An empty filter matches every " +
        "message in the mailbox, which is never what an unattended rule should do.",
    );
  }
  return { ok: true, value: out };
}

/**
 * Validates a stored action.
 *
 * Refuses delete-shaped actions by name BEFORE the whitelist check, so the
 * error explains the product rule rather than reading as an unrecognised value.
 */
export function validateTriageAction(raw: unknown): TriageValidation<TriageAction> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("action must be an object with a 'type'.");
  }
  const input = raw as Record<string, unknown>;
  const type = typeof input["type"] === "string" ? input["type"].trim().toLowerCase() : "";
  if (!type) return fail("action.type is required.");

  if (TRIAGE_FORBIDDEN_ACTION_TYPES.includes(type)) {
    return fail(
      `action.type '${type}' is not available to automations. Deleting mail is the ` +
        "one mailbox operation with neither an undo nor an approval gate, so an " +
        "unattended rule may not do it. Move matching mail to a folder instead and " +
        "delete it yourself once you have seen the run log.",
    );
  }

  switch (type) {
    case "move": {
      const folder = typeof input["folder"] === "string" ? neutralizeText(input["folder"]).trim() : "";
      if (!folder) return fail("action.folder is required for a move action.");
      if (folder.length > 200) return fail("action.folder must be at most 200 characters.");
      // See TRIAGE_FORBIDDEN_MOVE_DESTINATIONS: a move to trash is a delete on a timer.
      if (TRIAGE_FORBIDDEN_MOVE_DESTINATIONS.includes(triageFolderLeaf(folder))) {
        return fail(
          `action.folder '${folder}' is not available to automations. Every provider ` +
            "empties its trash and junk folders on a timer, so moving mail there " +
            "unattended is a delete with a delayed fuse, and automations do not delete " +
            "mail. Move it to a folder you own and review it there.",
        );
      }
      return { ok: true, value: { type: "move", folder } };
    }
    case "label": {
      const label = typeof input["label"] === "string" ? neutralizeText(input["label"]).trim() : "";
      if (!label) return fail("action.label is required for a label action.");
      if (label.length > 200) return fail("action.label must be at most 200 characters.");
      return { ok: true, value: { type: "label", label } };
    }
    case "mark_read":
      return { ok: true, value: { type: "mark_read" } };
    case "forward": {
      const rawTo = input["to"];
      if (!Array.isArray(rawTo)) return fail("action.to must be an array of email addresses.");
      const to = rawTo
        .filter((v): v is string => typeof v === "string")
        .map((v) => neutralizeText(v).trim())
        .filter((v) => v.length > 0);
      if (to.length === 0) return fail("action.to must contain at least one recipient.");
      if (to.length > TRIAGE_MAX_FORWARD_RECIPIENTS) {
        return fail(
          `action.to may contain at most ${TRIAGE_MAX_FORWARD_RECIPIENTS} recipients. ` +
            "An automation is not a mailing list.",
        );
      }
      const bad = to.find((address) => !EMAIL_RE.test(address));
      if (bad) return fail(`action.to contains an invalid email address: ${bad.slice(0, 80)}`);
      const noteRaw = input["note"];
      if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== "string") {
        return fail("action.note must be a string when present.");
      }
      const note = typeof noteRaw === "string" ? neutralizeText(noteRaw) : undefined;
      if (note && note.length > TRIAGE_MAX_FORWARD_NOTE_CHARS) {
        return fail(`action.note must be at most ${TRIAGE_MAX_FORWARD_NOTE_CHARS} characters.`);
      }
      return { ok: true, value: note ? { type: "forward", to, note } : { type: "forward", to } };
    }
    case "draft_reply": {
      const template = typeof input["template"] === "string" ? neutralizeText(input["template"]) : "";
      if (!template.trim()) return fail("action.template is required for a draft_reply action.");
      if (template.length > TRIAGE_MAX_TEMPLATE_CHARS) {
        return fail(`action.template must be at most ${TRIAGE_MAX_TEMPLATE_CHARS} characters.`);
      }
      return { ok: true, value: { type: "draft_reply", template } };
    }
    default:
      return fail(
        `action.type '${neutralizeText(type).slice(0, 40)}' is not recognised. ` +
          `Available: ${TRIAGE_ACTION_TYPES.join(", ")}.`,
      );
  }
}

export function validateTriageInterval(raw: unknown): TriageValidation<number> {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || !(TRIAGE_INTERVALS as readonly number[]).includes(value)) {
    return fail(`interval_minutes must be one of: ${TRIAGE_INTERVALS.join(", ")}.`);
  }
  return { ok: true, value };
}

export function validateTriageMaxMessages(raw: unknown): TriageValidation<number> {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isInteger(value) ||
    value < TRIAGE_MIN_MESSAGES_PER_RUN ||
    value > TRIAGE_MAX_MESSAGES_PER_RUN
  ) {
    return fail(
      `max_messages_per_run must be an integer between ${TRIAGE_MIN_MESSAGES_PER_RUN} ` +
        `and ${TRIAGE_MAX_MESSAGES_PER_RUN}.`,
    );
  }
  return { ok: true, value };
}

export function validateTriageName(raw: unknown): TriageValidation<string> {
  const name = typeof raw === "string" ? neutralizeText(raw).trim() : "";
  if (!name) return fail("name is required.");
  if (name.length > 80) return fail("name must be at most 80 characters.");
  return { ok: true, value: name };
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * The complete set of substitutable values. There is no other input.
 *
 * Note what is ABSENT: the message body, the preview, the snippet, the
 * recipient list, attachment names. `draft_reply` composes an outgoing artifact,
 * and an unattended composer that interpolated a body would let anyone who can
 * email the user write arbitrary text into a draft that sits in their Drafts
 * folder looking like something they wrote. `renderTriageTemplate` cannot reach
 * a body because it is never handed one.
 */
export interface TriageTemplateContext {
  sender_name: string;
  sender_email: string;
  subject: string;
  date: string;
}

export const TRIAGE_TEMPLATE_PLACEHOLDERS: (keyof TriageTemplateContext)[] = [
  "sender_name",
  "sender_email",
  "subject",
  "date",
];

/** HTML-escape. Drafts may be rendered as HTML by the provider's own composer. */
export function escapeTriageHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Substitutes the four whitelisted placeholders and nothing else.
 *
 * Everything else in the template is LITERAL TEXT. There is no expression
 * language, no nesting, no function calls, no property access, and no way to
 * reach a value that is not on `TriageTemplateContext`. An unknown placeholder
 * such as `{{body}}` or `{{message.body}}` is left exactly as written, which is
 * both the safe behaviour and a visible one: the author sees their typo in the
 * draft rather than getting silent emptiness.
 *
 * Substitution is single-pass. A value that itself contains `{{subject}}` (an
 * attacker can control the subject line) is NOT re-scanned, so a crafted subject
 * cannot smuggle a second substitution round.
 */
export function renderTriageTemplate(
  template: string,
  context: TriageTemplateContext,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    if (!TRIAGE_TEMPLATE_PLACEHOLDERS.includes(name as keyof TriageTemplateContext)) {
      // Deliberately returns the original token, not "". See the note above.
      return whole;
    }
    const value = context[name as keyof TriageTemplateContext] ?? "";
    return escapeTriageHtml(neutralizeText(String(value)));
  });
}

/** `subject_redacted` / `sender_redacted`: neutralized, then truncated. */
export function redactForRunLog(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const clean = neutralizeMaybe(value).trim();
  if (!clean) return null;
  return clean.length > TRIAGE_REDACTED_MAX_CHARS
    ? clean.slice(0, TRIAGE_REDACTED_MAX_CHARS - 1) + "…"
    : clean;
}

/** Provider error text reduced to one operator-facing sentence, never content. */
export function redactErrorDetail(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return neutralizeText(text).replace(/\s+/g, " ").trim().slice(0, 1000);
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** The rule row the dispatcher works with. Mirrors `triage_rules`. */
export interface TriageRuleRow {
  id: string;
  workspace_id: string;
  inbox_id: string;
  api_key_id: string;
  name: string;
  enabled: boolean;
  filter: unknown;
  action: unknown;
  interval_minutes: number;
  max_messages_per_run: number;
  next_run_at: string | null;
  running_since: string | null;
  consecutive_failures: number;
}

/** The authority a run acts with. Projected from `api_keys`. */
export interface TriageApiKey {
  id: string;
  workspace_id: string;
  name: string;
  scopes: string[];
  inbox_ids: string[] | null;
  expires_at: string | null;
  deleted_at: string | null;
}

/** The inbox, opaque to this module beyond identity. */
export interface TriageInbox {
  id: string;
  workspace_id: string;
  email_address: string;
  provider: string;
}

/** One search hit, projected to only what the runner may see. */
export interface TriageMatch {
  id: string;
  subject: string;
  from_name: string;
  from_email: string;
  date: string;
  folder?: string;
}

/** What a provider action reports back. */
export interface TriageActionOutcome {
  ok: boolean;
  error_code?: string | null;
  /** Ids and source location needed to reverse the action. Encrypted before storage. */
  undo?: Record<string, unknown> | null;
  /** Set by `forward`: the approval a human must decide. */
  approval_id?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * The narrow storage interface.
 *
 * Explicit methods rather than a PostgREST-style chainable client, because the
 * dedupe claim and the lease CAS are the two operations whose exact semantics
 * this feature depends on, and a test that has to mock a fluent builder is a
 * test that proves the mock works. index.ts supplies the real implementation.
 */
export interface TriageStore {
  /** Rules whose lease is older than the cutoff. Global, as befits a cron sweep. */
  listStaleLeases(cutoffIso: string): Promise<{ id: string }[]>;
  /** Release a stale lease and fail its open run. Never re-queues the run. */
  reclaimStaleLease(ruleId: string, nowIso: string): Promise<void>;
  /** Due, enabled, undeleted, unleased rules, oldest first. */
  listDueRules(nowIso: string, limit: number): Promise<TriageRuleRow[]>;
  /**
   * Optimistic compare-and-set lease claim. True when THIS caller won.
   *
   * Implemented as `UPDATE ... WHERE id=? AND running_since IS NULL AND enabled
   * AND next_run_at <= now()` and a check of the returned row count. No
   * SELECT ... FOR UPDATE and no advisory lock: that is the house style for
   * every claim in this codebase (scheduled_sends pending -> sending, bulk_plans
   * -> executing), and a zero-row update is an unambiguous "somebody else got it".
   */
  claimRule(ruleId: string, nowIso: string): Promise<boolean>;
  /** Release the lease and write the post-run scheduling state. */
  releaseRule(
    ruleId: string,
    update: {
      next_run_at: string;
      last_run_at: string;
      consecutive_failures: number;
      enabled?: boolean;
      disabled_reason?: string | null;
    },
  ): Promise<void>;
  createRun(input: {
    rule_id: string;
    workspace_id: string;
    trigger: "schedule" | "manual";
  }): Promise<string | null>;
  finishRun(
    runId: string | null,
    update: {
      status: "completed" | "completed_with_errors" | "failed" | "skipped";
      duration_ms: number;
      matched: number;
      processed: number;
      succeeded: number;
      failed: number;
      skipped: number;
      error_code?: string | null;
      error_detail?: string | null;
    },
  ): Promise<void>;
  /**
   * `INSERT ... ON CONFLICT DO NOTHING` against `triage_seen_messages`.
   *
   * Returns TRUE only when this call inserted the row, i.e. only when this run
   * is the first to claim the message. A false return means another run (or an
   * earlier pass of this one) already handled it, and the caller MUST NOT act.
   * This single boolean is what stops a re-dispatched run from moving the same
   * mail twice, which is the most damaging failure this feature could have.
   */
  claimMessage(ruleId: string, digest: string): Promise<boolean>;
  writeRunItem(input: {
    run_id: string | null;
    rule_id: string;
    message_digest: string;
    subject_redacted: string | null;
    sender_redacted: string | null;
    outcome: "applied" | "queued_for_approval" | "failed" | "skipped_duplicate";
    detail: Record<string, unknown>;
    undo_state: Record<string, unknown> | null;
  }): Promise<void>;
  loadApiKey(apiKeyId: string): Promise<TriageApiKey | null>;
  loadInbox(inboxId: string): Promise<TriageInbox | null>;
}

export interface TriageDeps {
  store: TriageStore;
  /** HMAC-SHA256(ENCRYPTION_KEY, provider_message_id). Keyed and one-way. */
  digest(providerMessageId: string): Promise<string>;
  /** AES-256-GCM, the same helper scheduled_sends.payload uses. */
  encrypt(plaintext: string): Promise<string>;
  /** Run a stored NormalizedSearch through the interactive search path. */
  search(inbox: TriageInbox, filter: NormalizedSearch, limit: number): Promise<TriageMatch[]>;
  /** Resolve a folder/label name to a provider-native id. */
  resolveFolder(inbox: TriageInbox, nameOrId: string): Promise<string>;
  /** Apply one action to one message. index.ts owns every provider call. */
  applyAction(input: {
    inbox: TriageInbox;
    apiKey: TriageApiKey;
    action: TriageAction;
    match: TriageMatch;
    /** Pre-resolved provider-native destination for move; null otherwise. */
    destinationId: string | null;
    /** Already rendered, escaped, and free of body content. */
    renderedTemplate: string | null;
  }): Promise<TriageActionOutcome>;
  /** `writeActivityLog` + `writeActionUsage`, per action. */
  meter(input: {
    workspaceId: string;
    apiKeyId: string;
    inboxId: string;
    operation: TriageOperationName;
    status: "success" | "error";
    errorCode: string | null;
    durationMs: number;
  }): Promise<void>;
  /** Injectable clock, for tests. */
  now?(): number;
}

function nowMs(deps: TriageDeps): number {
  return deps.now ? deps.now() : Date.now();
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/**
 * Re-derives, at RUN time, whether the rule's key may still do this.
 *
 * The rule stored an `api_key_id`, not a snapshot of that key's permissions, and
 * the difference matters: a rule created months ago must not keep acting on a
 * scope that has since been revoked, or on an inbox the key was later restricted
 * away from. Checking here means revocation takes effect on the next run rather
 * than on the next dashboard edit.
 */
export function checkTriageAuthority(
  apiKey: TriageApiKey | null,
  inboxId: string,
  action: TriageAction,
  nowIsoMs: number,
): { ok: true } | { ok: false; error_code: string; error_detail: string } {
  if (!apiKey || apiKey.deleted_at) {
    return {
      ok: false,
      error_code: "api_key_unavailable",
      error_detail: "The API key this automation runs as has been deleted or revoked.",
    };
  }
  if (apiKey.expires_at && Date.parse(apiKey.expires_at) <= nowIsoMs) {
    return {
      ok: false,
      error_code: "api_key_expired",
      error_detail: "The API key this automation runs as has expired.",
    };
  }
  const needed = TRIAGE_ACTION_SCOPES[action.type];
  if (!apiKey.scopes.includes(needed)) {
    return {
      ok: false,
      error_code: "scope_denied",
      error_detail: `The API key no longer holds the '${needed}' scope this automation needs.`,
    };
  }
  // draft_reply derives recipients and threading from the original message, so
  // it needs read:email exactly as the interactive draft_reply tool does.
  if (action.type === "draft_reply" && !apiKey.scopes.includes("read:email")) {
    return {
      ok: false,
      error_code: "scope_denied",
      error_detail: "The API key no longer holds the 'read:email' scope draft replies need.",
    };
  }
  if (apiKey.inbox_ids && !apiKey.inbox_ids.includes(inboxId)) {
    return {
      ok: false,
      error_code: "inbox_not_permitted",
      error_detail: "The API key is no longer permitted to act on this automation's inbox.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Running one rule
// ---------------------------------------------------------------------------

export interface TriageRunSummary {
  rule_id: string;
  status: "completed" | "completed_with_errors" | "failed" | "skipped";
  matched: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  error_code: string | null;
}

/**
 * Executes one already-leased rule end to end.
 *
 * Exported separately from the dispatcher so the manual "Run now" path and the
 * tests can drive a single rule without a cron round-trip. The CALLER owns the
 * lease: this function assumes it has been claimed and always releases it.
 */
export async function runTriageRule(
  deps: TriageDeps,
  rule: TriageRuleRow,
  trigger: "schedule" | "manual" = "schedule",
): Promise<TriageRunSummary> {
  const startedMs = nowMs(deps);
  const store = deps.store;
  const runId = await store.createRun({
    rule_id: rule.id,
    workspace_id: rule.workspace_id,
    trigger,
  });

  let matched = 0;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  /** Terminal failure: release the lease, count it, auto-disable at the ceiling. */
  const failRun = async (errorCode: string, errorDetail: string): Promise<TriageRunSummary> => {
    const consecutive = (rule.consecutive_failures ?? 0) + 1;
    const disable = consecutive >= TRIAGE_MAX_CONSECUTIVE_FAILURES;
    await store.finishRun(runId, {
      status: "failed",
      duration_ms: nowMs(deps) - startedMs,
      matched,
      processed,
      succeeded,
      failed,
      skipped,
      error_code: errorCode,
      error_detail: errorDetail.slice(0, 1000),
    });
    await store.releaseRule(rule.id, {
      next_run_at: new Date(nowMs(deps) + rule.interval_minutes * 60_000).toISOString(),
      last_run_at: new Date(nowMs(deps)).toISOString(),
      consecutive_failures: consecutive,
      // A rule pointed at a dead mailbox or a revoked key would otherwise retry
      // forever every fifteen minutes. Stopping is the correct end state, and
      // disabled_reason is what makes it explicable in the dashboard.
      ...(disable
        ? {
          enabled: false,
          disabled_reason:
            `Automatically disabled after ${consecutive} consecutive failed runs. ` +
            `Last error: ${errorCode}. Fix the cause and re-enable.`,
        }
        : {}),
    });
    return {
      rule_id: rule.id,
      status: "failed",
      matched,
      processed,
      succeeded,
      failed,
      skipped,
      error_code: errorCode,
    };
  };

  // ── Re-validate the stored rule ────────────────────────────────────────────
  // The row was validated when it was written, but a rule is long-lived and the
  // validator is the only thing standing between a hand-edited row and an
  // unattended mailbox action. Re-checking costs microseconds.
  const filterCheck = validateTriageFilter(rule.filter);
  if (!filterCheck.ok) return await failRun("invalid_filter", filterCheck.error);
  const actionCheck = validateTriageAction(rule.action);
  if (!actionCheck.ok) return await failRun("invalid_action", actionCheck.error);
  const action = actionCheck.value;

  // ── Authority ─────────────────────────────────────────────────────────────
  const apiKey = await store.loadApiKey(rule.api_key_id);
  const authority = checkTriageAuthority(apiKey, rule.inbox_id, action, nowMs(deps));
  if (!authority.ok) return await failRun(authority.error_code, authority.error_detail);
  const key = apiKey as TriageApiKey;

  const inbox = await store.loadInbox(rule.inbox_id);
  if (!inbox) {
    return await failRun("inbox_unavailable", "The inbox this automation targets no longer exists.");
  }

  // ── Match ─────────────────────────────────────────────────────────────────
  const cap = Math.min(
    Math.max(rule.max_messages_per_run, TRIAGE_MIN_MESSAGES_PER_RUN),
    TRIAGE_MAX_MESSAGES_PER_RUN,
  );
  let matches: TriageMatch[];
  try {
    matches = await deps.search(inbox, filterCheck.value, cap);
  } catch (error) {
    return await failRun("search_failed", redactErrorDetail(error));
  }
  matched = matches.length;

  // Move resolves its destination ONCE per run, not per message: the folder is a
  // property of the rule, and re-resolving would be one provider round-trip per
  // matched message for an answer that cannot change mid-run.
  let destinationId: string | null = null;
  if (action.type === "move") {
    try {
      destinationId = await deps.resolveFolder(inbox, action.folder);
    } catch (error) {
      return await failRun("folder_unresolved", redactErrorDetail(error));
    }
  }

  // ── Act, message by message ───────────────────────────────────────────────
  for (const match of matches.slice(0, cap)) {
    const digest = await deps.digest(match.id);

    // CLAIM BEFORE ACTING. Zero rows inserted means somebody already handled
    // this message for this rule, so we record the skip and do NOT touch the
    // mailbox. Doing this before the provider call, not after, is the entire
    // guarantee: a crash between the claim and the action loses one message,
    // whereas a claim after the action would double-move on every retry.
    const claimed = await store.claimMessage(rule.id, digest);
    if (!claimed) {
      skipped++;
      await store.writeRunItem({
        run_id: runId,
        rule_id: rule.id,
        message_digest: digest,
        subject_redacted: redactForRunLog(match.subject),
        sender_redacted: redactForRunLog(match.from_email),
        outcome: "skipped_duplicate",
        detail: { reason: "already_handled_by_this_rule" },
        undo_state: null,
      });
      continue;
    }

    processed++;
    const actionStartMs = nowMs(deps);
    let outcome: TriageActionOutcome;
    try {
      outcome = await deps.applyAction({
        inbox,
        apiKey: key,
        action,
        match,
        destinationId,
        renderedTemplate: action.type === "draft_reply"
          ? renderTriageTemplate(action.template, {
            sender_name: match.from_name,
            sender_email: match.from_email,
            subject: match.subject,
            date: match.date,
          })
          : null,
      });
    } catch (error) {
      outcome = { ok: false, error_code: redactErrorDetail(error).slice(0, 120) || "provider_error" };
    }

    // METERING AND AUDIT, per action. The /dispatch path historically wrote no
    // activity_log or action_usage rows at all, which meant background work was
    // invisible to both the audit trail and the meter. An unattended action is
    // exactly as real as an interactive one, so it is recorded exactly the same.
    await deps.meter({
      workspaceId: rule.workspace_id,
      apiKeyId: key.id,
      inboxId: inbox.id,
      operation: TRIAGE_ACTION_OPERATIONS[action.type],
      status: outcome.ok ? "success" : "error",
      errorCode: outcome.ok ? null : (outcome.error_code ?? "provider_error"),
      durationMs: nowMs(deps) - actionStartMs,
    });

    if (!outcome.ok) {
      failed++;
      await store.writeRunItem({
        run_id: runId,
        rule_id: rule.id,
        message_digest: digest,
        subject_redacted: redactForRunLog(match.subject),
        sender_redacted: redactForRunLog(match.from_email),
        outcome: "failed",
        detail: { error_code: outcome.error_code ?? "provider_error", ...(outcome.detail ?? {}) },
        undo_state: null,
      });
      continue;
    }

    succeeded++;
    // forward stops at an approval row: nothing has happened to the mailbox and
    // nothing will until a human decides. That is a distinct terminal outcome,
    // not a success, which is why the migration gave it its own value.
    const queued = typeof outcome.approval_id === "string" && outcome.approval_id.length > 0;
    let undoState: Record<string, unknown> | null = null;
    if (outcome.undo) {
      // Provider message ids ARE message identifiers, so the narrow carve-out
      // from fetch-live-never-store is encrypted, matching bulk_plans.scope.
      undoState = { v: 1, data: await deps.encrypt(JSON.stringify(outcome.undo)) };
    }
    await store.writeRunItem({
      run_id: runId,
      rule_id: rule.id,
      message_digest: digest,
      subject_redacted: redactForRunLog(match.subject),
      sender_redacted: redactForRunLog(match.from_email),
      outcome: queued ? "queued_for_approval" : "applied",
      detail: {
        action: action.type,
        ...(queued ? { approval_id: outcome.approval_id } : {}),
        ...(outcome.detail ?? {}),
      },
      undo_state: queued ? null : undoState,
    });
  }

  // ── Settle ────────────────────────────────────────────────────────────────
  // 'skipped' is a distinct status from 'completed' because a rule that only
  // ever skips is a misconfigured filter, and that is worth surfacing.
  const status: TriageRunSummary["status"] = failed > 0
    ? "completed_with_errors"
    : processed === 0
    ? "skipped"
    : "completed";
  const endedMs = nowMs(deps);
  await store.finishRun(runId, {
    status,
    duration_ms: endedMs - startedMs,
    matched,
    processed,
    succeeded,
    failed,
    skipped,
    error_code: null,
    error_detail: null,
  });
  await store.releaseRule(rule.id, {
    next_run_at: new Date(endedMs + rule.interval_minutes * 60_000).toISOString(),
    last_run_at: new Date(endedMs).toISOString(),
    // A run that completed, even with per-message errors, proves the mailbox and
    // the key are reachable. The failure counter tracks RUN failures, not
    // individual provider hiccups, so it resets here.
    consecutive_failures: 0,
  });

  return {
    rule_id: rule.id,
    status,
    matched,
    processed,
    succeeded,
    failed,
    skipped,
    error_code: null,
  };
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * Entry point for POST /triage-dispatch, called every minute by pg_cron.
 *
 * Modelled directly on `handleScheduledDispatch`: reclaim stale leases, select a
 * bounded batch, claim each with an optimistic CAS, run it, return counters. The
 * one structural difference is the wall-clock budget, which exists because a
 * triage run does provider I/O per matched message rather than one send per row.
 */
export async function handleTriageDispatch(deps: TriageDeps): Promise<Response> {
  const startedMs = nowMs(deps);
  const nowIso = new Date(startedMs).toISOString();
  const store = deps.store;

  // ── Reclaim stale leases ──────────────────────────────────────────────────
  // FAIL FORWARD. The open run is marked failed and never re-queued, matching
  // the settled rule for a stale 'sending' scheduled_send and a stuck
  // 'executing' bulk_plan: a partially applied run may already have moved half
  // its matches, and re-running it is not obviously safe for the rest.
  const staleCutoff = new Date(startedMs - TRIAGE_STALE_LEASE_MS).toISOString();
  let reclaimed = 0;
  try {
    const stale = await store.listStaleLeases(staleCutoff);
    for (const row of stale) {
      await store.reclaimStaleLease(row.id, nowIso);
      reclaimed++;
    }
  } catch (error) {
    // Non-fatal: log and continue to the due rules below, exactly as the
    // scheduled-send dispatcher does with its own reclaim.
    console.warn("[triage-dispatch] stale lease reclaim failed:", redactErrorDetail(error));
  }

  let due: TriageRuleRow[];
  try {
    due = await store.listDueRules(nowIso, MAX_RULES_PER_INVOCATION);
  } catch (error) {
    console.error("[triage-dispatch] failed to list due rules:", redactErrorDetail(error));
    return new Response(
      JSON.stringify({ error: "db_error", detail: redactErrorDetail(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let ran = 0;
  let failedRuns = 0;
  let contended = 0;
  let budgetExhausted = false;

  for (const rule of due) {
    if (nowMs(deps) - startedMs >= TRIAGE_TIME_BUDGET_MS) {
      // Return cleanly rather than being killed mid-rule. pg_cron re-invokes in
      // under a minute and the remaining rules are still due, so nothing is lost.
      budgetExhausted = true;
      break;
    }

    // Optimistic CAS. A zero-row update means a concurrent invocation claimed it
    // first; skip without touching the mailbox and without counting it.
    let claimed = false;
    try {
      claimed = await store.claimRule(rule.id, new Date(nowMs(deps)).toISOString());
    } catch (error) {
      console.warn("[triage-dispatch] could not claim rule", rule.id, redactErrorDetail(error));
      continue;
    }
    if (!claimed) {
      contended++;
      continue;
    }

    try {
      const summary = await runTriageRule(deps, rule, "schedule");
      ran++;
      if (summary.status === "failed") failedRuns++;
    } catch (error) {
      // runTriageRule handles its own failures and always releases the lease, so
      // reaching here means the store itself threw. Leave the lease alone: the
      // stale-lease sweep is the correct owner of that case, and guessing at a
      // release here could race a run that is somehow still in flight.
      failedRuns++;
      console.error("[triage-dispatch] rule", rule.id, "threw:", redactErrorDetail(error));
    }
  }

  console.log(
    `[triage-dispatch] Done: ran=${ran} failed=${failedRuns} contended=${contended} ` +
      `reclaimed=${reclaimed} due=${due.length} budget_exhausted=${budgetExhausted}`,
  );
  return new Response(
    JSON.stringify({
      ran,
      failed: failedRuns,
      contended,
      reclaimed,
      due: due.length,
      budget_exhausted: budgetExhausted,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// The `automation` MCP tool
//
// A consolidated, action-based tool, matching the shape of every other tool on
// the surface. It manages RULES; it never runs one inline. The one action that
// touches a mailbox at all is `preview`, and it is read-only by construction:
// it runs the filter and reports what WOULD match, applying nothing.
//
// Everything here writes through the service-role client. `triage_rules` has a
// SELECT-only RLS policy for members by design (see the migration): a permissive
// UPDATE policy would let a browser flip `enabled`, rewrite `api_key_id` to
// borrow another key's authority, or forge scheduling state.
// ---------------------------------------------------------------------------

/** The result shape every index.ts tool handler returns. */
export interface TriageToolResult {
  result: {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  logStatus: "success" | "error";
  logErrorCode: string | null;
}

export const AUTOMATION_ACTIONS = [
  "create",
  "list",
  "get",
  "update",
  "enable",
  "disable",
  "delete",
  "runs",
  "preview",
] as const;

export type AutomationActionName = typeof AUTOMATION_ACTIONS[number];

/** The subset of the Supabase client this section uses. Mirrors `BulkDb`. */
// deno-lint-ignore no-explicit-any
export interface AutomationDb { from(table: string): any }

export interface AutomationCaller {
  id: string;
  workspace_id: string;
  scopes: string[];
  /** Non-null = this key may only touch these inboxes. */
  inbox_ids: string[] | null;
}

export interface AutomationDeps {
  /** MUST be the service-role client: triage_rules has no member write policy. */
  db: AutomationDb;
  caller: AutomationCaller;
  /** Resolve `inbox_id` / `inbox` exactly as every other tool does. */
  resolveInbox(
    args: Record<string, unknown>,
  ): Promise<{ ok: true; inbox: TriageInbox } | { ok: false; message: string }>;
  /** Read-only dry run of a filter. Applies nothing. */
  preview(inbox: TriageInbox, filter: NormalizedSearch, limit: number): Promise<TriageMatch[]>;
  now?(): number;
}

function toolOk(payload: Record<string, unknown>): TriageToolResult {
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: false,
    },
    logStatus: "success",
    logErrorCode: null,
  };
}

function toolErr(text: string, code: string): TriageToolResult {
  return {
    result: { content: [{ type: "text", text }], isError: true },
    logStatus: "error",
    logErrorCode: code,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns safe to return to a model. Never the lease or internal counters raw. */
const AUTOMATION_PUBLIC_COLUMNS =
  "id, name, enabled, inbox_id, filter, action, interval_minutes, " +
  "max_messages_per_run, next_run_at, last_run_at, consecutive_failures, " +
  "disabled_reason, created_at, updated_at";

/**
 * Validates the create/update body as a whole.
 *
 * Deliberately validates the ACTION against the inbox's provider too: a label
 * action on an IMAP inbox is not a runtime failure to discover five minutes
 * later in a run log, it is a rule that can never work, and the moment to say so
 * is when it is being written.
 */
export function validateAutomationBody(
  args: Record<string, unknown>,
  inboxProvider: string | null,
  partial: boolean,
): TriageValidation<{
  name?: string;
  filter?: NormalizedSearch;
  action?: TriageAction;
  interval_minutes?: number;
  max_messages_per_run?: number;
}> {
  const out: Record<string, unknown> = {};

  if (args["name"] !== undefined || !partial) {
    const check = validateTriageName(args["name"]);
    if (!check.ok) return fail(check.error);
    out.name = check.value;
  }
  if (args["filter"] !== undefined || !partial) {
    const check = validateTriageFilter(args["filter"]);
    if (!check.ok) return fail(check.error);
    out.filter = check.value;
  }
  if (args["action"] !== undefined || !partial) {
    const check = validateTriageAction(args["action"]);
    if (!check.ok) return fail(check.error);
    if (check.value.type === "label" && inboxProvider && inboxProvider !== "gmail") {
      return fail(
        "action.type 'label' is only available on Gmail inboxes. Labels are a Gmail " +
          "concept; on this inbox use action.type 'move' with a folder instead.",
      );
    }
    out.action = check.value;
  }
  if (args["interval_minutes"] !== undefined || !partial) {
    const check = validateTriageInterval(args["interval_minutes"]);
    if (!check.ok) return fail(check.error);
    out.interval_minutes = check.value;
  }
  if (args["max_messages_per_run"] !== undefined) {
    const check = validateTriageMaxMessages(args["max_messages_per_run"]);
    if (!check.ok) return fail(check.error);
    out.max_messages_per_run = check.value;
  }
  return { ok: true, value: out };
}

/** Loads one rule, scoped to the caller's workspace. Tenancy is never implicit. */
async function loadAutomation(
  deps: AutomationDeps,
  ruleId: string,
  // deno-lint-ignore no-explicit-any
): Promise<any | null> {
  const { data, error } = await deps.db
    .from("triage_rules")
    .select(AUTOMATION_PUBLIC_COLUMNS)
    .eq("id", ruleId)
    .eq("workspace_id", deps.caller.workspace_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export async function runAutomationTool(
  action: string,
  rawArgs: unknown,
  deps: AutomationDeps,
): Promise<TriageToolResult> {
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return toolErr("automation: arguments must be an object with an 'action'.", "-32602");
  }
  const rawObj = rawArgs as Record<string, unknown>;
  const nowIso = new Date(deps.now ? deps.now() : Date.now()).toISOString();

  // Normalize the rule's action key before anything reads it.
  //
  // The consolidated tool exposes it as `rule_action` because `action` is the
  // operation selector, and index.ts copies rule_action -> action on the way in.
  // But that copy only happens when the caller SUPPLIED rule_action: on an
  // update that changes only the name, `action` is still the literal string
  // "update", and treating that as a rule action produces a baffling error about
  // a missing action.type. So the rule action is whatever came in as
  // `rule_action`, or an `action` that is an object; a bare string is the
  // selector and is discarded here.
  const args: Record<string, unknown> = { ...rawObj };
  const ruleAction = rawObj["rule_action"] !== undefined
    ? rawObj["rule_action"]
    : (rawObj["action"] !== null && typeof rawObj["action"] === "object"
      ? rawObj["action"]
      : undefined);
  if (ruleAction === undefined) delete args["action"];
  else args["action"] = ruleAction;

  const ruleIdArg = typeof args["automation_id"] === "string" ? args["automation_id"].trim() : "";
  const needsId = ["get", "update", "enable", "disable", "delete", "runs"].includes(action);
  if (needsId && !UUID_RE.test(ruleIdArg)) {
    return toolErr("automation: a valid automation_id (UUID) is required for this action.", "-32602");
  }

  switch (action) {
    case "create": {
      const resolved = await deps.resolveInbox(args);
      if (!resolved.ok) return toolErr(`automation create: ${resolved.message}`, "inbox_not_found");
      const body = validateAutomationBody(args, resolved.inbox.provider, false);
      if (!body.ok) return toolErr(`automation create: ${body.error}`, "-32602");
      const needed = TRIAGE_ACTION_SCOPES[(body.value.action as TriageAction).type];
      if (!deps.caller.scopes.includes(needed)) {
        return toolErr(
          `automation create: this key needs the '${needed}' scope to create an ` +
            "automation with that action. The rule runs as this key, so it can never " +
            "do more than the key itself may do.",
          "scope_denied",
        );
      }
      const { data, error } = await deps.db
        .from("triage_rules")
        .insert({
          workspace_id: deps.caller.workspace_id,
          inbox_id: resolved.inbox.id,
          api_key_id: deps.caller.id,
          name: body.value.name,
          filter: body.value.filter,
          action: body.value.action,
          interval_minutes: body.value.interval_minutes,
          ...(body.value.max_messages_per_run !== undefined
            ? { max_messages_per_run: body.value.max_messages_per_run }
            : {}),
          // Rules are created OFF and next_run_at stays null until enable.
          // Enabling is always a separate, explicit act, so no unattended
          // mailbox work can begin as a side effect of creating a rule.
          enabled: false,
          next_run_at: null,
        })
        .select(AUTOMATION_PUBLIC_COLUMNS)
        .maybeSingle();
      if (error || !data) {
        return toolErr(`automation create: could not save the rule (${error?.code ?? "unknown"}).`, "db_error");
      }
      return toolOk({
        automation: data,
        enabled: false,
        message:
          "Created and DISABLED. Nothing will run until you call automation with " +
          "action 'enable'. Call action 'preview' first to see what the filter matches.",
      });
    }

    case "list": {
      const { data, error } = await deps.db
        .from("triage_rules")
        .select(AUTOMATION_PUBLIC_COLUMNS)
        .eq("workspace_id", deps.caller.workspace_id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return toolErr("automation list: could not read automations.", "db_error");
      return toolOk({ automations: data ?? [], count: (data ?? []).length });
    }

    case "get": {
      const rule = await loadAutomation(deps, ruleIdArg);
      if (!rule) return toolErr("automation get: no automation with that id in this workspace.", "not_found");
      return toolOk({ automation: rule });
    }

    case "update": {
      const rule = await loadAutomation(deps, ruleIdArg);
      if (!rule) return toolErr("automation update: no automation with that id in this workspace.", "not_found");
      const resolved = await deps.resolveInbox({ inbox_id: rule.inbox_id });
      const provider = resolved.ok ? resolved.inbox.provider : null;
      const body = validateAutomationBody(args, provider, true);
      if (!body.ok) return toolErr(`automation update: ${body.error}`, "-32602");
      if (Object.keys(body.value).length === 0) {
        return toolErr("automation update: supply at least one of name, filter, action, interval_minutes, max_messages_per_run.", "-32602");
      }
      if (body.value.action) {
        const needed = TRIAGE_ACTION_SCOPES[body.value.action.type];
        if (!deps.caller.scopes.includes(needed)) {
          return toolErr(`automation update: this key needs the '${needed}' scope for that action.`, "scope_denied");
        }
      }
      const { data, error } = await deps.db
        .from("triage_rules")
        .update(body.value)
        .eq("id", ruleIdArg)
        .eq("workspace_id", deps.caller.workspace_id)
        .is("deleted_at", null)
        .select(AUTOMATION_PUBLIC_COLUMNS)
        .maybeSingle();
      if (error || !data) return toolErr("automation update: could not save the change.", "db_error");
      return toolOk({ automation: data });
    }

    case "enable": {
      const rule = await loadAutomation(deps, ruleIdArg);
      if (!rule) return toolErr("automation enable: no automation with that id in this workspace.", "not_found");
      // Re-validate before letting it loose. A rule may have been written when
      // the key held a scope it has since lost, and enabling is the moment that
      // matters, because it is the moment unattended work becomes possible.
      const actionCheck = validateTriageAction(rule.action);
      if (!actionCheck.ok) return toolErr(`automation enable: the stored action is invalid (${actionCheck.error})`, "invalid_action");
      const needed = TRIAGE_ACTION_SCOPES[actionCheck.value.type];
      if (!deps.caller.scopes.includes(needed)) {
        return toolErr(`automation enable: this key needs the '${needed}' scope to enable that action.`, "scope_denied");
      }
      const { data, error } = await deps.db
        .from("triage_rules")
        .update({
          enabled: true,
          disabled_reason: null,
          consecutive_failures: 0,
          // Due immediately, so enabling has a visible effect within a minute
          // rather than one cadence later.
          next_run_at: nowIso,
        })
        .eq("id", ruleIdArg)
        .eq("workspace_id", deps.caller.workspace_id)
        .is("deleted_at", null)
        .select(AUTOMATION_PUBLIC_COLUMNS)
        .maybeSingle();
      if (error || !data) return toolErr("automation enable: could not enable the automation.", "db_error");
      return toolOk({ automation: data, enabled: true });
    }

    case "disable": {
      const { data, error } = await deps.db
        .from("triage_rules")
        .update({ enabled: false, next_run_at: null, disabled_reason: "Disabled by request." })
        .eq("id", ruleIdArg)
        .eq("workspace_id", deps.caller.workspace_id)
        .is("deleted_at", null)
        .select(AUTOMATION_PUBLIC_COLUMNS)
        .maybeSingle();
      if (error || !data) return toolErr("automation disable: no automation with that id in this workspace.", "not_found");
      // NOTE: a run already in flight is NOT cancelled. It holds a lease and
      // will finish its current batch, then release with next_run_at set and
      // enabled false, so nothing further is scheduled. Killing a run mid-way
      // would leave a partially applied batch with no record of where it stopped.
      return toolOk({
        automation: data,
        enabled: false,
        message: "Disabled. A run already in progress finishes its current batch; nothing further is scheduled.",
      });
    }

    case "delete": {
      // SOFT delete. Run history outlives the rule on purpose: it is the record
      // of what was done to a mailbox, and it is exactly what a user goes
      // looking for after the fact.
      const { data, error } = await deps.db
        .from("triage_rules")
        .update({ deleted_at: nowIso, enabled: false, next_run_at: null })
        .eq("id", ruleIdArg)
        .eq("workspace_id", deps.caller.workspace_id)
        .is("deleted_at", null)
        .select("id, name")
        .maybeSingle();
      if (error || !data) return toolErr("automation delete: no automation with that id in this workspace.", "not_found");
      return toolOk({
        deleted: true,
        automation_id: data.id,
        message: "Automation deleted. Its run history is kept, because it is the record of what was done to the mailbox.",
      });
    }

    case "runs": {
      const limitArg = typeof args["limit"] === "number" ? args["limit"] : 20;
      const limit = Math.min(Math.max(Math.trunc(limitArg) || 20, 1), 100);
      const rule = await loadAutomation(deps, ruleIdArg);
      if (!rule) return toolErr("automation runs: no automation with that id in this workspace.", "not_found");
      const { data, error } = await deps.db
        .from("triage_runs")
        .select("id, status, trigger, started_at, completed_at, duration_ms, matched, processed, succeeded, failed, skipped, error_code, error_detail")
        .eq("rule_id", ruleIdArg)
        .eq("workspace_id", deps.caller.workspace_id)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) return toolErr("automation runs: could not read the run history.", "db_error");
      return toolOk({ automation_id: ruleIdArg, runs: data ?? [], count: (data ?? []).length });
    }

    case "preview": {
      // A DRY RUN. It runs the filter and reports what would match right now,
      // and applies nothing: it never claims a message in the dedupe ledger,
      // never writes a run, and never calls applyAction. That is what makes it
      // safe to offer before a rule is enabled, which is precisely when a user
      // most wants to know what a filter does.
      const resolved = await deps.resolveInbox(args);
      if (!resolved.ok) return toolErr(`automation preview: ${resolved.message}`, "inbox_not_found");

      let filter: NormalizedSearch;
      if (args["automation_id"] !== undefined) {
        if (!UUID_RE.test(ruleIdArg)) return toolErr("automation preview: automation_id must be a UUID.", "-32602");
        const rule = await loadAutomation(deps, ruleIdArg);
        if (!rule) return toolErr("automation preview: no automation with that id in this workspace.", "not_found");
        const check = validateTriageFilter(rule.filter);
        if (!check.ok) return toolErr(`automation preview: the stored filter is invalid (${check.error})`, "invalid_filter");
        filter = check.value;
      } else {
        const check = validateTriageFilter(args["filter"]);
        if (!check.ok) return toolErr(`automation preview: ${check.error}`, "-32602");
        filter = check.value;
      }

      const capArg = typeof args["max_messages_per_run"] === "number"
        ? args["max_messages_per_run"]
        : 25;
      const cap = Math.min(Math.max(Math.trunc(capArg) || 25, TRIAGE_MIN_MESSAGES_PER_RUN), TRIAGE_MAX_MESSAGES_PER_RUN);

      let matches: TriageMatch[];
      try {
        matches = await deps.preview(resolved.inbox, filter, cap);
      } catch (error) {
        return toolErr(`automation preview: the search failed (${redactErrorDetail(error)}).`, "search_failed");
      }
      return toolOk({
        applied: false,
        inbox_id: resolved.inbox.id,
        matched: matches.length,
        capped_at: cap,
        // Redacted exactly as a run log entry would be, so the preview and the
        // history a user later reads say the same thing about the same message.
        matches: matches.map((m) => ({
          subject: redactForRunLog(m.subject),
          from: redactForRunLog(m.from_email),
          date: m.date,
          folder: m.folder ?? null,
        })),
        untrusted_content: true,
        message: "Dry run. Nothing was changed and no message was claimed in the deduplication ledger.",
      });
    }

    default:
      return toolErr(
        `automation: unknown action '${neutralizeText(String(action)).slice(0, 40)}'. ` +
          `Available: ${AUTOMATION_ACTIONS.join(", ")}.`,
        "-32602",
      );
  }
}
