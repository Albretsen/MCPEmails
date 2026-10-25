// ---------------------------------------------------------------------------
// Every sentence this card sends to the model, in one file.
//
// `ui/update-model-context` is the card's only voice in the conversation, and
// each call OVERWRITES the last one (the spec says so, and it is what makes the
// rules below matter). So every string built here obeys the same five, and a
// new one has to as well:
//
//   1. FACTS ONLY. What the user did and what the server said about it. Never
//      a sentence that tells the model what to do next.
//   2. BODY-FREE. Counts, never the user's words. The subject is the one piece
//      of content quoted, as contract §7 allows, and it is clipped and held to
//      one line.
//   3. THE LIVE ID. On IMAP every save retires the draft id and returns a new
//      one, so a line names the id that resolves NOW and never the one the card
//      was mounted with. Where the id has stopped resolving, the line says so.
//   4. SELF-CONTAINED. Because of the overwrite, a line cannot lean on the one
//      before it. "Sent" on its own replaced the only sentence that said which
//      draft, and left the model holding an outcome with no subject. Each line
//      therefore restates what it is about: the id, the subject, how many
//      recipients.
//   5. THE OUTCOME THE SERVER REPORTED, not the button that was pressed. A line
//      is chosen after the call returns, from what came back.
//
// Pure, DOM-free and exported, so the harness pins the exact text of each one.
// ---------------------------------------------------------------------------

import type { ToolResultParams } from "./bridge";
import type { DraftEditorData, Envelope, Outbound, Plan, Receipt } from "./contract";
import { bulkVerb, wordCount } from "./format";
import { neutralizeText } from "./sanitize";

// ---- shared pieces ---------------------------------------------------------

/**
 * An instant as ISO 8601 in UTC, to the second: `2026-10-13T10:04:00Z`.
 *
 * The saved line used to carry a bare wall-clock time ("at 10:04") formatted in
 * the browser's locale and zone. The model has neither, so it could not place
 * that time against anything else in the conversation, and "10:04" yesterday
 * and today read the same. Falls back to the card's own clock when the server
 * sent no usable timestamp, which is still the moment the answer arrived.
 */
export function contextInstant(iso: string | null | undefined): string {
  const given = typeof iso === "string" ? new Date(iso) : null;
  const d = given && !isNaN(given.getTime()) ? given : new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Text that did not come from this file, made safe to sit inside a sentence:
 * one line, bounded, in double quotes of its own.
 *
 * Used for the subject (the user's, or on a reply a third party's) and for the
 * server's own account of a failure. Neither may be able to end the sentence it
 * is quoted in and start another, which a newline or a closing quote would let
 * it do.
 */
function quoted(text: string | null | undefined, max: number): string {
  const flat = neutralizeText(String(text ?? ""))
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .trim();
  return `"${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}"`;
}

const SUBJECT_MAX = 200;
const SERVER_TEXT_MAX = 300;

type DraftFacts = Pick<DraftEditorData, "draft_id" | "subject" | "recipients">;

/** `Subject: "…". To 1, cc 0, bcc 1.` Counts, never addresses. */
function draftShape(d: DraftFacts): string {
  const subject = (d.subject ?? "").trim() ? quoted(d.subject, SUBJECT_MAX) : '"(no subject)"';
  const to = d.recipients?.to?.length ?? 0;
  const cc = d.recipients?.cc?.length ?? 0;
  const bcc = d.recipients?.bcc?.length ?? 0;
  return `Subject: ${subject}. To ${to}, cc ${cc}, bcc ${bcc}.`;
}

const idOf = (d: DraftFacts): string => d.draft_id || "unknown";

/**
 * The one fact about the body the model cannot work out for itself: that what
 * is stored is no longer what it wrote. Appended to every line about a draft
 * that still exists, because any of them may be the line left standing.
 */
const BODY_DIFFERS =
  "The body now differs from the text the agent last wrote, and draft_read returns the current text.";

// ---- the request ------------------------------------------------------------

/**
 * The params of one `ui/update-model-context` request, for what the host
 * advertised as `hostCapabilities.updateModelContext`.
 *
 * ── What the spec and the reference SDK say (checked 2026-10-17) ───────────
 * ext-apps 2026-01-26 and the current draft, and the v2.0.3 SDK, whose wire
 * protocol is unchanged from 1.x:
 *   * params are `{ content?: ContentBlock[], structuredContent? }`;
 *   * "Each request overwrites the previous context sent by the View", per
 *     View: Claude's docs say each widget instance pushes its own, so another
 *     card in the same chat does not overwrite this one's;
 *   * the host "MAY defer sending the context to the model until the next user
 *     message" and "SHOULD only send the last update". So nothing reaches the
 *     model at the moment of a save: it arrives with the user's next message;
 *   * an EMPTY update clears the context (the reference host treats no
 *     content and no structuredContent as "clear"). Never send one;
 *   * the capability's value is `SupportedContentBlockModalities`
 *     (`text`, `image`, `audio`, `resource`, `resourceLink`,
 *     `structuredContent`), and a host may refuse a block it did not list
 *     (-32000 "Invalid content format");
 *   * the maintainers' guidance (ext-apps#380) is that a host gives the model
 *     `content` and falls back to `structuredContent` only when `content` is
 *     empty, and that an app passing `structuredContent` also passes a text
 *     version in `content`.
 *
 * So: the text always goes as one `text` block, the shape every example in the
 * SDK uses. `structuredContent` is added only when the host LISTED it, because
 * a host that reads only structured data is the one case where text alone
 * would not reach the model, and a host that did not list it may refuse it.
 *
 * ── What Claude does with it (re-test 2026-10-17) ──────────────────────────
 * Compared against the spec (specification/draft/apps.mdx) and the SDK's
 * `App.updateModelContext` (src/app.ts, no capability check, method
 * "ui/update-model-context", params passed through): the method name, the
 * params shape and the timing here match, and with Claude advertising
 * `cap[text,image]` the one `text` block is a modality it listed. Claude
 * answered all three updates with success (diagnostics `3/0/3`), yet on the
 * NEXT user turn, asked without tools what the subject was now and what had
 * changed in the card, it said nothing about edits, saves or sends had reached
 * it. So claude.ai accepts the request and does not, as of that date, put it
 * in front of the model on the next turn (the spec's SHOULD), and nothing on
 * the card's side can change that. How Claude handles it is not documented.
 * The card still sends it (a host that follows the spec gets it, and Claude
 * may start to), but nothing may depend on it: the server tells the model the
 * same facts in the next draft result for that draft, including a model's
 * `draft_read` (supabase/functions/mcp-server/card-activity.ts), and the
 * draft tool descriptions send a model to `draft_read` before it states a
 * draft's current state. `ui/message` would reach the model but posts into
 * the chat as the user, so it is not used for this.
 */
export function modelContextParams(
  text: string,
  advertised: unknown,
): { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } {
  const listed =
    advertised && typeof advertised === "object" && !Array.isArray(advertised)
      ? Object.keys(advertised as Record<string, unknown>)
      : [];
  return {
    content: [{ type: "text", text }],
    ...(listed.includes("structuredContent")
      ? { structuredContent: { source: "MCPEmails draft card", context: text } }
      : {}),
  };
}

/**
 * `cap[text,structuredContent]`, `cap[]` or `nocap`, for the diagnostics line:
 * what the host said it accepts, which is the first fact a live check needs.
 */
export function modelContextCapability(advertised: unknown): string {
  if (!advertised || typeof advertised !== "object" || Array.isArray(advertised)) return "nocap";
  return `cap[${Object.keys(advertised as Record<string, unknown>).join(",")}]`;
}

// ---- the draft card --------------------------------------------------------

/**
 * When a fresh draft result first renders.
 *
 * Without it the model has no fact that the card is on screen: the tool result
 * is the same whether or not a host draws the card, so a model in a host it
 * believes cannot render one told the user "the card probably won't show up"
 * over a card the user was looking at (2026-10-25). Hosts deliver this with
 * the next user message, so it serves the turns after the call, not the reply
 * the call is part of. Any later line from this card replaces it, and each of
 * those also says the card is the MCPEmails card. No body count: the body may
 * still be deferred (contract §8) when the card first renders.
 */
export function draftShownContextLine(draft: DraftFacts): string {
  return (
    `The MCPEmails draft card is on screen for the user, who can edit and send it. ` +
    `Its current draft_id is ${idOf(draft)}. ${draftShape(draft)}`
  );
}

/**
 * After a successful save.
 *
 * `bodyEdited` is "a save from this card has changed the body since the agent
 * last wrote it", which is wider than "THIS save changed it": a body edit
 * followed by a subject-only save must still say the body differs, because the
 * second line replaces the first. App.tsx keeps that across saves. When it is
 * false the line says only that this save left the body alone, which is all
 * the card knows; it does not claim the body is the agent's.
 */
export function draftSavedContextLine(
  draft: DraftFacts & Pick<DraftEditorData, "body" | "last_saved_at">,
  opts: { bodyEdited: boolean },
): string {
  return (
    `The user saved edits to a draft in the MCPEmails card at ${contextInstant(draft.last_saved_at)}. ` +
    `Its current draft_id is ${idOf(draft)}. ${draftShape(draft)} ` +
    `Body ${wordCount(draft.body?.text)} words. ` +
    (opts.bodyEdited ? BODY_DIFFERS : "This save did not change the body.")
  );
}

/** What a draft action from the card turned out to be. See `draftCallOutcome`. */
export type DraftCallOutcome =
  | { kind: "sent"; sentAt: string | null }
  | { kind: "held"; approvalId: string | null }
  | { kind: "discarded" }
  | { kind: "hidden" }
  | { kind: "failed"; said: string; delivery: "not_sent" | "unknown" | null }
  | { kind: "no_answer"; why: string };

export type DraftAction = "send" | "discard" | "hide";

/** One `tools/call` from the draft card, as App.tsx#callDraft hands it back. */
export interface DraftCall {
  /** The envelope the server answered with, before it was merged. */
  envelope: Envelope | null;
  /** The raw result, for the answers that are not an envelope at all. */
  result: ToolResultParams | null;
  /** The message of a call that threw: a JSON-RPC error, a refusal, a timeout. */
  thrown: string | null;
}

const UNREADABLE = "the response was not in a form the card reads";

function failureText(result: ToolResultParams | null, receipt?: Receipt): string {
  if (receipt) {
    return [receipt.headline, receipt.detail].filter((s) => typeof s === "string" && s.trim()).join(" ");
  }
  const text = result?.content?.find((c) => c?.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function deliveryOf(result: ToolResultParams | null): "not_sent" | "unknown" | null {
  const sc = result?.structuredContent;
  const v = result?.delivery_status ?? sc?.delivery_status;
  return v === "not_sent" || v === "unknown" ? v : null;
}

/**
 * Read the outcome of a draft action off what the server actually returned.
 *
 * Enumerated against `executeSendDraft`, `executeDeleteDraft` and
 * `runDraftEditorHide` on 2026-10-13, because the card used to announce only a
 * receipt headline and most of what those functions return has none:
 *
 *   send     a `receipt` envelope with outcome `sent`                  -> sent
 *            the SAME success with no envelope (`{draft_id, message_id,
 *            sent_at}` alone: the editor is hidden for the inbox, or its
 *            flag could not be read)                                   -> sent
 *            an `outbound_review` envelope: the inbox requires approval,
 *            so the send was queued and the provider was not called    -> held
 *            the same hold with no envelope (`status:
 *            "pending_approval"`)                                      -> held
 *            `isError` with prose and no envelope: no recipients, the
 *            draft id is stale, auth, quota, a refused or failed
 *            submission                                                -> failed
 *   discard  a `receipt` with outcome `discarded`, or `{deleted: true}`
 *            alone                                                     -> discarded
 *            `isError` with prose                                      -> failed
 *   hide     a `receipt` whose outcome is ALSO `discarded` (the server
 *            reuses the word for "the card went away")                 -> hidden
 *            a failed receipt                                          -> failed
 *   any      the call threw, or answered in a shape none of the above  -> no_answer
 *
 * That `hide` and `discard` share an outcome word is why this takes the ACTION
 * and does not read the receipt alone: announcing a hidden card as a deleted
 * draft would be a false statement about the user's mail.
 */
export function draftCallOutcome(action: DraftAction, call: DraftCall): DraftCallOutcome {
  if (call.thrown !== null) return { kind: "no_answer", why: call.thrown };
  const { envelope: env, result } = call;
  const sc = (result?.structuredContent ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  if (env) {
    const failed = env.state === "error" || env.receipt?.outcome === "failed";
    if (failed) {
      return { kind: "failed", said: failureText(result, env.receipt), delivery: deliveryOf(result) };
    }
    if (action === "send" && env.card === "outbound_review" && env.outbound) {
      return { kind: "held", approvalId: str(env.outbound.approval_id) };
    }
    if (env.card === "receipt" && env.receipt) {
      const outcome = env.receipt.outcome;
      if (action === "send" && (outcome === "sent" || outcome === "scheduled")) {
        return { kind: "sent", sentAt: str(env.sent_at) };
      }
      if (action === "discard" && outcome === "discarded") return { kind: "discarded" };
      if (action === "hide") return { kind: "hidden" };
    }
    return { kind: "no_answer", why: UNREADABLE };
  }

  if (!result) return { kind: "no_answer", why: UNREADABLE };
  if (result.isError === true) {
    return { kind: "failed", said: failureText(result), delivery: deliveryOf(result) };
  }
  if (action === "send" && sc.status === "pending_approval") {
    return { kind: "held", approvalId: str(sc.approval_id) };
  }
  if (action === "send" && (str(sc.sent_at) || str(sc.message_id))) {
    return { kind: "sent", sentAt: str(sc.sent_at) };
  }
  if (action === "discard" && sc.deleted === true) return { kind: "discarded" };
  return { kind: "no_answer", why: UNREADABLE };
}

const PRESSED: Record<DraftAction, string> = {
  send: "pressed Send on",
  discard: "pressed Delete draft on",
  hide: "asked to hide the draft editor card while viewing",
};

/**
 * The line for one draft action.
 *
 * `draft` is the draft AS IT WAS WHEN THE BUTTON WAS PRESSED, after any save
 * that ran first, so its id is the live one for every outcome in which the
 * draft still exists and the last one it had for the two in which it does not.
 *
 * ── What a failure does and does not claim ─────────────────────────────────
 * Only what the server's answer supports. A send the server marked `not_sent`
 * is still in Drafts and the line says so. One it marked `unknown` may have
 * left, and a stale id means the draft is not at that id at all, so those two
 * do not get the same sentence: "still in Drafts" is asserted exactly where it
 * was reported and nowhere else.
 */
export function draftActionContextLine(
  action: DraftAction,
  draft: DraftFacts,
  outcome: DraftCallOutcome,
  opts: { bodyEdited: boolean; scope?: "inbox" | "workspace" },
): string {
  const id = idOf(draft);
  const shape = draftShape(draft);
  const body = opts.bodyEdited ? ` ${BODY_DIFFERS}` : "";

  switch (outcome.kind) {
    case "sent":
      return (
        `The user sent draft ${id} from the MCPEmails card at ${contextInstant(outcome.sentAt)}. ${shape} ` +
        `The message has left Drafts, so that draft_id no longer resolves.` +
        (opts.bodyEdited
          ? " The user edited the body in the card before sending, so the sent text differs from the text the agent last wrote."
          : "")
      );
    case "held":
      return (
        `The user pressed Send on draft ${id} in the MCPEmails card. ${shape} ` +
        `The send is held for approval${outcome.approvalId ? ` under approval_id ${outcome.approvalId}` : ""} and nothing has been sent. ` +
        `The draft is still in Drafts under that draft_id.${body}`
      );
    case "discarded":
      return (
        `The user discarded draft ${id} from the MCPEmails card. ${shape} ` +
        `Nothing was sent. The draft was deleted from Drafts, so that draft_id no longer resolves.`
      );
    case "hidden":
      return (
        `The user hid the MCPEmails draft editor card for ${
          opts.scope === "workspace" ? "every inbox in the workspace" : "this inbox"
        }. That is a display setting only. ` +
        `Draft ${id} was not sent, changed or deleted and is still in Drafts under that draft_id. ${shape}${body}`
      );
    case "failed": {
      const said = `The server reported: ${quoted(outcome.said || "no reason", SERVER_TEXT_MAX)}.`;
      if (action === "hide") {
        return (
          `The user asked to hide the MCPEmails draft editor card and it was not hidden. ${said} ` +
          `Draft ${id} was not sent, changed or deleted and is still in Drafts under that draft_id. ${shape}${body}`
        );
      }
      if (action === "discard") {
        return (
          `The user pressed Delete draft on draft ${id} in the MCPEmails card and the delete failed. ${shape} ${said} ` +
          `The card still holds the draft under that draft_id.${body}`
        );
      }
      const after =
        outcome.delivery === "not_sent"
          ? "Nothing was sent, and the draft is still in Drafts under that draft_id."
          : outcome.delivery === "unknown"
            ? "Whether the message was delivered is not known, so the draft may or may not still be in Drafts."
            : "Nothing was reported as sent, and the card still holds the draft under that draft_id.";
      return (
        `The user pressed Send on draft ${id} in the MCPEmails card and the send failed. ${shape} ${said} ${after}${body}`
      );
    }
    case "no_answer": {
      const unknown =
        action === "send"
          ? "The card does not know whether the message was sent."
          : action === "discard"
            ? "The card does not know whether the draft was deleted."
            : "The card does not know whether it was hidden. The draft itself is not affected by that setting.";
      return (
        `The user ${PRESSED[action]} draft ${id} in the MCPEmails card and the card got no usable answer ` +
        `(${quoted(outcome.why, SERVER_TEXT_MAX)}). ${shape} ${unknown}${body}`
      );
    }
  }
}

// ---- the outbound review card ----------------------------------------------

/** `approval_id …. Subject: "…". To 2, cc 1, bcc 0.` for a queued send. */
function outboundShape(o: Outbound): string {
  const subject = (o.subject ?? "").trim() ? quoted(o.subject, SUBJECT_MAX) : '"(no subject)"';
  const to = o.recipients?.to?.length ?? 0;
  const cc = o.recipients?.cc?.length ?? 0;
  const bcc = o.recipients?.bcc_count ?? 0;
  return `Subject: ${subject}. To ${to}, cc ${cc}, bcc ${bcc}.`;
}

/**
 * After the user pressed Reject, from what `approval_decide` answered.
 *
 * It used to be sent whatever came back, so a send that had already expired or
 * been decided in the dashboard was announced as rejected by the user. Null
 * when the answer was not an envelope at all: the card then says nothing, and
 * the pending-approval text the model already has stays true.
 */
export function outboundRejectContextLine(o: Outbound, answer: Envelope | null): string | null {
  if (!answer) return null;
  const about = `the queued send under approval_id ${o.approval_id}`;
  if (answer.state !== "error" && answer.receipt?.outcome === "rejected") {
    return `The user rejected ${about} in the MCPEmails card. ${outboundShape(o)} Nothing was sent.`;
  }
  if (!answer.receipt) return null;
  return (
    `The user pressed Reject on ${about} in the MCPEmails card, and that press did not reject it. ` +
    `${outboundShape(o)} The server reported: ${quoted(failureText(null, answer.receipt), SERVER_TEXT_MAX)}.`
  );
}

/** After the approval page was opened in the user's browser. */
export function outboundApproveOpenedContextLine(o: Outbound): string {
  return (
    `The user opened the approval page in their browser for the queued send under approval_id ${o.approval_id}. ` +
    `${outboundShape(o)} The send is still pending until they approve it there. An agent cannot approve it.`
  );
}

// ---- the bulk plan card ----------------------------------------------------

/** `bulk plan <id> (delete of 128 matched messages)`. No sample, no scope text. */
function planShape(plan: Plan): string {
  return `bulk plan ${plan.plan_id} (${bulkVerb(plan.action).toLowerCase()} of ${plan.match_count} matched messages)`;
}

/** After the user confirmed a plan, from what `bulk_execute` answered. */
export function bulkExecuteContextLine(plan: Plan, answer: Envelope | null): string | null {
  if (!answer?.receipt) return null;
  const head = `The user confirmed ${planShape(plan)} in the MCPEmails card.`;
  const r = answer.receipt;
  if (answer.state !== "error" && r.outcome === "executed") {
    const n = typeof r.affected_count === "number" ? ` ${r.affected_count} messages were affected.` : "";
    return `${head} The plan ran.${n}`;
  }
  return `${head} The server reported: ${quoted(failureText(null, r), SERVER_TEXT_MAX)}.`;
}

/** After the user cancelled a plan in the card. Local: no server call is made. */
export function bulkCancelContextLine(plan: Plan): string {
  return `The user cancelled ${planShape(plan)} in the MCPEmails card. Nothing was changed.`;
}

/**
 * After the card ran `subscriptions_cleanup` (§9). Counts only: sender names
 * and addresses come from email and never go into the conversation.
 */
export function subscriptionCleanupContextLine(answer: Envelope | null): string | null {
  const head = "The user confirmed a subscription cleanup in the MCPEmails card.";
  const s = answer?.subscriptions;
  if (answer?.card === "subscription_plan" && s && answer.state === "executed") {
    const n: Record<string, number> = {};
    for (const r of s.results ?? []) n[r.status] = (n[r.status] ?? 0) + 1;
    const c = (k: string) => n[k] ?? 0;
    const parts = `Requested ${c("requested")}, drafts saved for the user to send (not sent) ${c("draft_ready")}, links for the user to open ${c("needs_user")}, failed ${c("failed")}, other ${(s.results?.length ?? 0) - c("requested") - c("draft_ready") - c("needs_user") - c("failed")}`;
    const b = s.backlog;
    const tail = b && b.action === "archive"
      ? ` ${b.moved} existing messages archived${b.has_more ? `, ${b.remaining} left` : ""}.`
      : "";
    return `${head} ${parts}.${tail}`;
  }
  if (answer?.receipt) {
    return `${head} The server reported: ${quoted(failureText(null, answer.receipt), SERVER_TEXT_MAX)}.`;
  }
  return null;
}
