// ---------------------------------------------------------------------------
// stale-listing-hint.ts - telling the model that ChatGPT is calling us from a
// tool list it cached before the per-operation listing, so no card can show.
//
// ── The problem ─────────────────────────────────────────────────────────────
// An OpenAI key has been listed one tool per operation since 2026-10-13
// (PER_OPERATION_LISTING in index.ts). ChatGPT caches an app's tool list and
// does not re-read it: not on a new OAuth link, not on `initialize`, and not on
// notifications/tools/list_changed. So a ChatGPT connection set up before that
// date keeps calling the consolidated names (`draft`, `email_compose`, ...).
// Those calls still work, but the cached entries carry no `_meta.ui`, so the
// card never mounts, and the model has been seen telling the user to "edit the
// draft in the editor above" when there is none.
//
// Measured 2026-10-26 over 7 days of function logs: 56 of 158 OpenAI keys
// that called a write or organize tool still called consolidated names only
// (54 workspaces), and 55 of the 56 made no `tools/list` in that window. Only a
// manual tool reload in ChatGPT's app settings fixes it.
//
// ── What this does ──────────────────────────────────────────────────────────
// A call by a consolidated card-bearing name that the per-operation listing no
// longer has is proof of a stale listing. When that call comes from a ChatGPT
// key AND the card would have been in this key's listing, the result carries a
// note: no card is shown here, and how the user can reload the tools.
//
// Gated on the card gate on purpose: most of those workspaces have no card
// today (the draft editor is still an internal rollout), and telling them to
// reload for an editor they would not get is wrong. Not for Codex: it renders
// no card, so reloading gains it nothing.
//
// Attaching the card's `_meta.ui` to the RESULT instead was considered and
// rejected: ChatGPT picks the template from the tool descriptor it cached, not
// from the result, so it would not render.
// ---------------------------------------------------------------------------

import {
  BULK_PLAN_CARD_TOOL_NAMES,
  DRAFT_EDITOR_CARD_TOOL_NAMES,
  REVIEW_CARD_TOOL_NAMES,
} from "./mcp-app-resources.ts";

/**
 * True when `toolName` is a consolidated tool that can carry the card AND the
 * per-operation listing does not list it, so an OpenAI client calling it must
 * be working from a listing cached before 2026-10-13.
 *
 * `listedPerOperation` is the per-operation listing's names (passed in, since
 * index.ts owns that listing). `email_delete` is on the bulk list but also a
 * per-operation name, so it never counts.
 */
export function isStaleListingCardCall(
  toolName: string,
  listedPerOperation: ReadonlySet<string>,
): boolean {
  if (listedPerOperation.has(toolName)) return false;
  return REVIEW_CARD_TOOL_NAMES.includes(toolName) ||
    BULK_PLAN_CARD_TOOL_NAMES.includes(toolName) ||
    DRAFT_EDITOR_CARD_TOOL_NAMES.includes(toolName);
}

/**
 * True when this result is one the user actually loses something on without
 * the card.
 *
 * Since 2026-10-27 the outbound card is listed for every key that can send
 * (index.ts#keyCanSendOutbound), so the card gate alone would now attach the
 * reload note to every ordinary ChatGPT send. On an ordinary send the card is a
 * one-line receipt and the model's reply already says the same, so telling the
 * user to reload for it is noise. For `email_compose` and `schedule` the note is
 * kept to a HELD send (`status: "pending_approval"`), which is what the
 * outbound card exists to review, exactly the case the note was written for.
 * Every other card-bearing tool is unchanged.
 */
export function staleHintHasCardToMiss(toolName: string, structuredContent: unknown): boolean {
  if (!REVIEW_CARD_TOOL_NAMES.includes(toolName)) return true;
  return !!structuredContent && typeof structuredContent === "object" &&
    (structuredContent as Record<string, unknown>).status === "pending_approval";
}

/**
 * True when the client on this key is ChatGPT, not Codex or Agent Builder.
 *
 * `clientName` is the latest name sent at `initialize`, or null when the key
 * never sent one (a ChatGPT link that reuses a cached list sends none). Then
 * the OAuth key name decides: `OAuth: ChatGPT` or `OAuth: chatgpt.com`.
 */
export function isChatGptHost(keyName: string | null | undefined, clientName: string | null): boolean {
  if (clientName !== null) return clientName.trim().toLowerCase() === "openai-mcp";
  return typeof keyName === "string" && /^OAuth: chatgpt(\.com)?( \(\d+\))?$/i.test(keyName.trim());
}

/** The note for the model. Plain words, no em dashes; the model may relay it. */
export const STALE_LISTING_NOTE =
  "ChatGPT is using an old copy of the MCPEmails tool list, so no MCPEmails card or editor is shown in this chat. " +
  "Do not tell the user to use an editor or card. Tell the user once in this conversation: to get the card, open " +
  "MCPEmails in ChatGPT's app settings and reload its tools, or disconnect and reconnect it.";
