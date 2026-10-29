// ---------------------------------------------------------------------------
// "Confirm in chat" (`inboxes.send_review_mode = 'chat'`, 2026-10-23).
//
// Testers of the draft editor card reported that their assistant sometimes
// sent without the card ever appearing, and that it mixed up the MCPEmails
// draft with a draft tool from another connector. This mode makes every send
// from the inbox a two-call exchange:
//
//   1. The first send is refused (`chat_confirmation_required`, nothing sent).
//      The refusal tells the model to show the user the message, in the draft
//      card when it can, ask for a yes in the chat, and only then repeat the
//      call with the `confirmation` code the refusal carries.
//   2. The repeat is checked here: the code must be ours (HMAC), for this key,
//      inbox and operation, for the SAME content (a changed message needs a new
//      yes), not older than CHAT_CONFIRM_TTL_MS, and not younger than
//      CHAT_CONFIRM_MIN_WAIT_MS, which catches a model that retries in the same
//      breath instead of asking.
//
// WHAT THIS IS NOT. The code is model-visible, so a model that decides to skip
// the question can wait a few seconds and repeat the call. This is a guardrail
// for an assistant that means well and gets it wrong, the case testers hit. The
// security boundary for sends stays the `inline` and `dashboard` review modes,
// where only a signed-in owner or admin can approve. Copy must not claim more.
//
// A Send pressed in the draft editor card (it carries `base_revision`) IS the
// user's confirmation and is not asked again. `base_revision` is model-visible
// too, which is the same limit stated above.
//
// Pure module: index.ts cannot be imported by a test. The caller injects the
// HMAC (`sign`), so tests run without ENCRYPTION_KEY.
// ---------------------------------------------------------------------------

export const CHAT_CONFIRM_MODE = "chat";
export const CHAT_CONFIRM_ERROR_CODE = "chat_confirmation_required";
/** A confirmation older than this is refused: the user said yes to a message long ago. */
export const CHAT_CONFIRM_TTL_MS = 30 * 60 * 1000;
/** A repeat faster than this cannot have waited for a human answer. */
export const CHAT_CONFIRM_MIN_WAIT_MS = 5_000;

const TOKEN_PREFIX = "c1";
const MAC_HEX_CHARS = 32;

/** What a confirmation is bound to. */
export interface ChatConfirmBinding {
  apiKeyId: string;
  inboxId: string;
  /** Dispatch name: email_send, email_reply, email_forward, draft_send, schedule_create. */
  operation: string;
  /** Digest of the message content, see `chatConfirmContent`. */
  contentDigest: string;
}

export type ChatConfirmVerdict =
  | "ok"
  | "missing"
  | "malformed"
  | "mismatch"
  | "expired"
  | "too_soon";

/** HMAC-SHA256 hex of a string. index.ts passes its ENCRYPTION_KEY HMAC. */
export type Signer = (value: string) => Promise<string>;

/** Stable JSON so key order cannot change a digest. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${
    Object.keys(obj).sort()
      .filter((key) => obj[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")
  }}`;
}

/**
 * Arguments that do not change what is sent, so a repeat that differs only in
 * them is the same message: the code itself, the retry key, and how the inbox
 * was named (the caller binds the RESOLVED inbox id instead).
 */
const NON_CONTENT_ARGS = new Set(["confirmation", "idempotency_key", "inbox", "inbox_id"]);

/** The part of a send's arguments a confirmation covers. */
export function chatConfirmContent(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!NON_CONTENT_ARGS.has(key)) out[key] = value;
  }
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Digest of a send's content, for `ChatConfirmBinding.contentDigest`. */
export function chatConfirmDigest(content: unknown): Promise<string> {
  return sha256Hex(stableJson(content));
}

async function mac(sign: Signer, binding: ChatConfirmBinding, issuedAt: string): Promise<string> {
  const full = await sign(
    `chat-confirm:v1:${binding.apiKeyId}:${binding.inboxId}:${binding.operation}:${binding.contentDigest}:${issuedAt}`,
  );
  return full.slice(0, MAC_HEX_CHARS);
}

/** A confirmation code for this exact message, issued now. */
export async function issueChatConfirmation(
  sign: Signer,
  binding: ChatConfirmBinding,
  nowMs: number,
): Promise<string> {
  const issuedAt = Math.floor(nowMs).toString(36);
  return `${TOKEN_PREFIX}-${issuedAt}-${await mac(sign, binding, issuedAt)}`;
}

/** Checks a `confirmation` argument against the message being sent now. */
export async function verifyChatConfirmation(
  sign: Signer,
  binding: ChatConfirmBinding,
  token: unknown,
  nowMs: number,
): Promise<ChatConfirmVerdict> {
  if (token === undefined || token === null || token === "") return "missing";
  if (typeof token !== "string") return "malformed";
  const parts = token.trim().split("-");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[0-9a-z]{1,12}$/.test(parts[1])) {
    return "malformed";
  }
  const expected = await mac(sign, binding, parts[1]);
  if (!timingSafeEqual(expected, parts[2].toLowerCase())) return "mismatch";
  const issuedMs = parseInt(parts[1], 36);
  const age = nowMs - issuedMs;
  if (!Number.isFinite(age) || age > CHAT_CONFIRM_TTL_MS || age < -60_000) return "expired";
  if (age < CHAT_CONFIRM_MIN_WAIT_MS) return "too_soon";
  return "ok";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Which tool call the model repeats, in the consolidated tool surface. */
const REPEAT_CALL: Record<string, string> = {
  email_send: "email_compose{action:'send'}",
  email_reply: "email_compose{action:'reply'}",
  email_forward: "email_compose{action:'forward'}",
  draft_send: "draft{action:'send'}",
  schedule_create: "schedule{action:'create'}",
};

/**
 * The refusal the model reads. Written for the model, not the user: it says
 * what to show, where, and what counts as a yes.
 */
export function chatConfirmRefusalText(input: {
  operation: string;
  verdict: Exclude<ChatConfirmVerdict, "ok">;
  token: string;
  inboxAddress: string;
  /** The draft editor card is on for this workspace and inbox. */
  cardAvailable: boolean;
  /** For draft_send: the draft being sent. */
  draftId?: string;
}): string {
  const call = REPEAT_CALL[input.operation] ?? input.operation;
  const why = {
    missing: "",
    malformed: "The confirmation code was not recognised. ",
    mismatch: "The confirmation code is for a different message, or the message changed since the user saw it. ",
    expired: "The confirmation code has expired. ",
    too_soon: "The confirmation came back too fast to be the user's answer. ",
  }[input.verdict];
  const lines = [
    `${input.operation}: not sent. ${why}${input.inboxAddress} asks for the user's confirmation in the chat before anything is sent.`,
  ];
  if (input.operation === "draft_send") {
    lines.push(
      input.cardAvailable
        ? `Point the user to the MCPEmails draft card for ${input.draftId ?? "this draft"} (call draft_read to show it if it is not on screen), and ask whether to send it. They can also press Send in the card themselves.`
        : `Show the user the draft (call draft_read: from, to, cc, bcc, subject and the full body) and ask whether to send it.`,
    );
  } else if (input.cardAvailable && (input.operation === "email_send" || input.operation === "email_reply")) {
    lines.push(
      `Prefer the draft card: save this message with draft{action:'${input.operation === "email_reply" ? "reply" : "create"}'} so the user sees it in the MCPEmails draft card, ` +
        "then call draft{action:'send'} without a code, which answers with the code for that draft, and ask the user once. " +
        "If you cannot use the card, show the user the full message (from, to, cc, bcc, subject, body, attachments) and ask.",
    );
  } else {
    lines.push("Show the user the full message (from, to, cc, bcc, subject, body, attachments) and ask whether to send it.");
  }
  lines.push(
    `Only after the user answers yes in the chat, repeat the same ${call} call with confirmation: "${input.token}". ` +
      "Do not add the code before the user has answered, and ask again if anything in the message changes. " +
      "Use this server's draft and send tools for this inbox, not a draft tool from another connector.",
  );
  return lines.join(" ");
}
