// ---------------------------------------------------------------------------
// The checkout link in the Free-cap refusal: who gets one, and how it is made.
//
// Plan: Documents/plans/paywall-checkout-link-20261024.md. Migration:
// 20261024180000_chat_checkout_links.sql (table checkout_links, RPC
// checkout_link_issue, column workspaces.chat_checkout_link_enabled, draft
// experiment `chat_checkout_link`).
//
// ── WHAT IT IS ─────────────────────────────────────────────────────────────
// When a Free workspace runs out of monthly actions inside a chat, the refusal
// can carry a link that opens Stripe Checkout for Personal monthly directly,
// with no dashboard and no sign-in. The person pays, goes back to the chat and
// says "continue"; the model re-issues the same call, which now passes because
// the cap check reads the plan on every call.
//
// ── WHO GETS ONE (checkoutLinkPrecheck + mintCheckoutLink) ─────────────────
// All of these, or nobody:
//
//   1. The refusal is the Free monthly action cap. The paid fair-use ceiling,
//      the per-minute rate limit and the inbox cap never carry a link: nothing
//      sells against the first two, and the third never fires in chat.
//   2. The client is not OpenAI's. OpenAI's plugin guidelines forbid linking
//      to a checkout page, and a directory install cannot be told apart from a
//      developer-mode connector, so every ChatGPT and Codex key is out, by key
//      name or by the latest `initialize` client name. If that lookup FAILED,
//      the answer is "no link": the existing isOpenAiClientKey fails open to
//      "not OpenAI" because there it only picks a listing shape, but here a
//      wrong guess puts a checkout link in front of a client whose rules
//      forbid it.
//   3. The key's user is the workspace owner. The subscription the checkout
//      creates belongs to the owner, and a member's agent offering to buy the
//      owner a plan is the wrong conversation. `api_keys.created_by` must
//      equal `workspaces.owner_id`; a key with no recorded creator is out,
//      because "probably the owner" is not good enough for a payment page.
//   4. The rollout says so: CHAT_CHECKOUT_LINK = off (default, and any value
//      this file does not know) | internal (workspaces with
//      chat_checkout_link_enabled) | experiment (arm `link` of the
//      `chat_checkout_link` experiment) | on.
//   5. CHECKOUT_LINK_SECRET is set and at least 32 characters long.
//
// The experiment is consulted LAST, after every other condition passed, so
// both arms hold the same population: capped Free owners on eligible clients.
// An assignment written for someone who could never have seen the link would
// only dilute the control arm.
//
// ── THE TOKEN ──────────────────────────────────────────────────────────────
// id = crypto.randomUUID(); token = base64url-no-padding(HMAC-SHA256(secret,
// utf8(id))), 43 characters; only sha256(utf8(token)) is stored. Deriving the
// token from the id is what lets a repeat refusal inside the window hand back
// the SAME link (checkout_link_issue returns the live row's id, and the token
// is re-derived from it) without the plaintext ever touching the database.
// The web route that redeems a link hashes what it is given and needs no
// secret. apps/web mirrors this contract; change both or neither.
//
// ── FAILURE ────────────────────────────────────────────────────────────────
// Every failure (missing secret, a read or RPC error, an experiment that
// cannot be resolved) returns null and logs ONE fixed event,
// `checkout_link_mint_failed`, with the workspace id and the error message
// only. The caller then renders today's text. A refusal must never get worse,
// or slower to fail, because a sales feature broke.
//
// ── COST ───────────────────────────────────────────────────────────────────
// Called only on the refused branch of actionLimitResponse. A successful call
// never reaches this file (automation-cap-wiring.test.ts proves it against the
// real handleRequest).
// ---------------------------------------------------------------------------

import { clientLabel } from "./client-label.ts";
import { isOpenAiClientName, isOpenAiOAuthKeyName } from "./security-schemes.ts";

/** Lifetime of a freshly minted link, to first open. Owner decision 2026-10-24;
 * also Stripe's minimum Checkout Session expiry. */
export const CHECKOUT_LINK_TTL_MINUTES = 30;

/** The experiment row seeded by the migration (draft, control/link, 50/50). */
export const CHECKOUT_LINK_EXPERIMENT_KEY = "chat_checkout_link";

/** The experiment arm that gets the link. */
export const CHECKOUT_LINK_VARIANT = "link";

/** HMAC keys shorter than this are refused, so a placeholder cannot ship. */
export const CHECKOUT_LINK_SECRET_MIN_LENGTH = 32;

/** The one log event every mint failure writes. Fixed, so alerts can match it. */
export const CHECKOUT_LINK_MINT_FAILED = "checkout_link_mint_failed";

export type CheckoutLinkMode = "off" | "internal" | "experiment" | "on";

/** CHAT_CHECKOUT_LINK, read strictly: anything unrecognised is `off`. */
export function checkoutLinkMode(raw: string | null | undefined): CheckoutLinkMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "internal" || value === "experiment" || value === "on" ? value : "off";
}

/** The secret, or null when it is missing or too short to trust. */
export function usableCheckoutSecret(raw: string | null | undefined): string | null {
  return typeof raw === "string" && raw.length >= CHECKOUT_LINK_SECRET_MIN_LENGTH ? raw : null;
}

// ── Client label ────────────────────────────────────────────────────────────
// What the link row records about the client, for the per-client read-out. A
// fixed family, never the raw `initialize` name (self-reported, free text) and
// never a User-Agent. The families that matter for the read-out are named
// first (claude.ai and Claude Code are different funnels); everything else
// falls through to client-label.ts's needle list, then `unknown`.

const CLIENT_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ["anthropic/claudeai", "claude_ai"],
  ["claude-ai", "claude_ai"],
  ["claude-code", "claude_code"],
  ["anthropic/toolbox", "anthropic_toolbox"],
];

export function checkoutClientLabel(clientName: string | null | undefined): string {
  const name = (clientName ?? "").trim().toLowerCase();
  if (!name) return "unknown";
  for (const [prefix, label] of CLIENT_FAMILIES) if (name.startsWith(prefix)) return label;
  return clientLabel(name);
}

// ── Eligibility, the part with no I/O ───────────────────────────────────────

export interface CheckoutLinkRequest {
  workspaceId: string;
  /** The refused workspace's plan, from the reservation. */
  plan: string;
  /** `api_keys.name`. */
  keyName: string | null | undefined;
  /** `api_keys.created_by`. */
  keyCreatedBy: string | null | undefined;
  /**
   * The latest `initialize` client name on this key: a string, null when the
   * key has never sent one, or undefined when the lookup FAILED.
   */
  clientName: string | null | undefined;
  /** The resolved billable tool name that was refused. */
  blockedTool: string;
  appOrigin: string;
  /** Raw CHAT_CHECKOUT_LINK. */
  modeEnv: string | null | undefined;
  /** Raw CHECKOUT_LINK_SECRET. */
  secretEnv: string | null | undefined;
}

export type PrecheckResult =
  | { eligible: true; mode: Exclude<CheckoutLinkMode, "off">; secret: string }
  | { eligible: false; reason: string };

/**
 * Every condition that needs no database. Cheap, and ordered so the common
 * "feature is off" case returns before anything else is looked at.
 */
export function checkoutLinkPrecheck(req: CheckoutLinkRequest): PrecheckResult {
  const mode = checkoutLinkMode(req.modeEnv);
  if (mode === "off") return { eligible: false, reason: "mode_off" };
  if (req.plan !== "free") return { eligible: false, reason: "not_free" };
  if (isOpenAiOAuthKeyName(req.keyName)) return { eligible: false, reason: "openai_key" };
  if (req.clientName === undefined) return { eligible: false, reason: "client_unknown" };
  if (isOpenAiClientName(req.clientName)) return { eligible: false, reason: "openai_client" };
  if (!req.keyCreatedBy) return { eligible: false, reason: "no_key_user" };
  const secret = usableCheckoutSecret(req.secretEnv);
  if (!secret) return { eligible: false, reason: "no_secret" };
  return { eligible: true, mode, secret };
}

// ── Experiment assignment, mirrored from apps/web/src/lib/experiments ──────
// bucketing.ts and resolve.ts, restated because the edge function cannot import
// from apps/web. Same hash, same input string, same precedence, so a subject
// lands in the same arm whichever side assigns it first. Overrides (an admin
// preview cookie) do not exist here.

/** cyrb53, exactly as bucketing.ts has it. */
function cyrb53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashUnit(subjectId: string, experimentKey: string): number {
  return cyrb53(`${experimentKey}:${subjectId}`) / 2 ** 53;
}

export interface ExperimentVariant {
  id: string;
  weight: number;
}

export interface ExperimentRow {
  key: string;
  status: string;
  variants: ExperimentVariant[] | null;
  winner_variant_id: string | null;
}

export function pickVariant(variants: ExperimentVariant[], unit: number): string {
  const scaled = unit * 100;
  let cumulative = 0;
  let lastPositive: string | null = null;
  for (const variant of variants) {
    if (variant.weight <= 0) continue;
    lastPositive = variant.id;
    cumulative += variant.weight;
    if (scaled < cumulative) return variant.id;
  }
  return lastPositive ?? variants[0]?.id ?? "control";
}

/** The experiment subject for a workspace: its uuid without dashes, 32 hex. */
export function experimentSubjectId(workspaceId: string): string | null {
  const subject = workspaceId.replace(/-/g, "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(subject) ? subject : null;
}

/**
 * resolve.ts precedence, minus overrides: no row -> control; concluded with a
 * winner -> the winner; anything not running -> variants[0]; running -> hash,
 * then store, and the STORED value wins. Unlike the web side, a failed assign
 * throws instead of serving the hashed arm: an exposure that was never written
 * down cannot be counted, and here the safe arm is the one with no link.
 */
export async function resolveExperimentVariant(
  experiment: ExperimentRow | null,
  subjectId: string,
  assign: (key: string, subjectId: string, variantId: string) => Promise<string>,
): Promise<string> {
  if (!experiment) return "control";
  const variants = Array.isArray(experiment.variants) ? experiment.variants : [];
  const control = variants[0]?.id ?? "control";
  if (experiment.status === "concluded" && experiment.winner_variant_id) return experiment.winner_variant_id;
  if (experiment.status !== "running") return control;
  const picked = pickVariant(variants, hashUnit(subjectId, experiment.key));
  const stored = await assign(experiment.key, subjectId, picked);
  return stored || picked;
}

// ── Token ───────────────────────────────────────────────────────────────────

function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url-no-padding(HMAC-SHA256(utf8(secret), utf8(id))): 43 characters. */
export async function deriveCheckoutToken(secret: string, id: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(id));
  return base64UrlNoPad(new Uint8Array(mac));
}

/** SHA-256 over utf8(token): the only form of the token that is stored. */
export async function checkoutTokenHash(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

/** A bytea literal PostgREST accepts in a JSON body: `\x` then lowercase hex. */
export function byteaHex(bytes: Uint8Array): string {
  return "\\x" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function checkoutLinkUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/+$/, "")}/u/${token}`;
}

// ── Minting ─────────────────────────────────────────────────────────────────

export interface CheckoutIssueArgs {
  p_id: string;
  p_token_hash: string;
  p_workspace_id: string;
  p_owner_user_id: string;
  p_client_label: string;
  p_blocked_tool: string | null;
  p_variant: string;
  p_ttl_minutes: number;
}

export interface CheckoutIssueRow {
  id: string;
  expires_at: string;
  reused: boolean;
}

/**
 * The database, injected. index.ts binds it to the service-role client; the
 * tests drive every branch with a fake. Each method THROWS on an error rather
 * than returning an empty answer, so "no row" and "could not ask" never blur.
 */
export interface CheckoutLinkIo {
  /** `workspaces.owner_id, chat_checkout_link_enabled`, or null for no row. */
  workspace(workspaceId: string): Promise<{ owner_id: string | null; chat_checkout_link_enabled: boolean | null } | null>;
  experiment(key: string): Promise<ExperimentRow | null>;
  assign(key: string, subjectId: string, variantId: string): Promise<string>;
  issue(args: CheckoutIssueArgs): Promise<CheckoutIssueRow | null>;
  /** Defaults to crypto.randomUUID; injectable so tests are deterministic. */
  newId?: () => string;
  /** Defaults to Date.now. */
  now?: () => number;
  /** Defaults to console.error. */
  logError?: (event: string, fields: Record<string, unknown>) => void;
}

export interface MintedCheckoutLink {
  url: string;
  /** ISO timestamp the link stops opening. */
  expiresAt: string;
  /** Whole minutes left on the link, at least 1. */
  minutes: number;
  /** Whether this is the workspace's existing live link. */
  reused: boolean;
  /** What the row recorded as its arm: `link`, `internal` or `on`. */
  variant: string;
}

const BLOCKED_TOOL_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Decide, and when the answer is yes, mint or reuse the workspace's link.
 * Returns null for "no link", whether by rule or by failure; only failures log.
 */
export async function mintCheckoutLink(
  io: CheckoutLinkIo,
  req: CheckoutLinkRequest,
): Promise<MintedCheckoutLink | null> {
  const pre = checkoutLinkPrecheck(req);
  if (!pre.eligible) return null;
  const logError = io.logError ??
    ((event: string, fields: Record<string, unknown>) => console.error(`[mcp-server] ${event}`, fields));
  try {
    const workspace = await io.workspace(req.workspaceId);
    const ownerId = workspace?.owner_id ?? null;
    if (!ownerId || ownerId !== req.keyCreatedBy) return null;

    let variant: string;
    if (pre.mode === "internal") {
      if (workspace?.chat_checkout_link_enabled !== true) return null;
      variant = "internal";
    } else if (pre.mode === "experiment") {
      const subject = experimentSubjectId(req.workspaceId);
      if (!subject) return null;
      const arm = await resolveExperimentVariant(
        await io.experiment(CHECKOUT_LINK_EXPERIMENT_KEY),
        subject,
        io.assign,
      );
      if (arm !== CHECKOUT_LINK_VARIANT) return null;
      variant = CHECKOUT_LINK_VARIANT;
    } else {
      variant = "on";
    }

    const proposedId = (io.newId ?? (() => crypto.randomUUID()))();
    const proposedToken = await deriveCheckoutToken(pre.secret, proposedId);
    const row = await io.issue({
      p_id: proposedId,
      p_token_hash: byteaHex(await checkoutTokenHash(proposedToken)),
      p_workspace_id: req.workspaceId,
      p_owner_user_id: ownerId,
      p_client_label: checkoutClientLabel(req.clientName),
      p_blocked_tool: BLOCKED_TOOL_RE.test(req.blockedTool) ? req.blockedTool : null,
      p_variant: variant,
      p_ttl_minutes: CHECKOUT_LINK_TTL_MINUTES,
    });
    if (!row || typeof row.id !== "string" || typeof row.expires_at !== "string") {
      throw new Error("checkout_link_issue returned no row");
    }
    // A reused row carries ITS id; the token is re-derived from that, which is
    // the whole reason the token is a function of the id.
    const token = row.id === proposedId ? proposedToken : await deriveCheckoutToken(pre.secret, row.id);
    const expiresMs = Date.parse(row.expires_at);
    if (Number.isNaN(expiresMs)) throw new Error("checkout_link_issue returned an unreadable expires_at");
    // Rounded, not floored: a fresh link has 29.99 minutes left by the time
    // this line runs, and it is a 30-minute link.
    const left = Math.round((expiresMs - (io.now ?? Date.now)()) / 60_000);
    return {
      url: checkoutLinkUrl(req.appOrigin, token),
      expiresAt: row.expires_at,
      minutes: Math.min(CHECKOUT_LINK_TTL_MINUTES, Math.max(1, left)),
      reused: row.reused === true,
      variant,
    };
  } catch (err) {
    logError(CHECKOUT_LINK_MINT_FAILED, {
      workspace_id: req.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
