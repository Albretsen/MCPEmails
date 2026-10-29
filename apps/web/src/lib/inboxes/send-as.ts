// ---------------------------------------------------------------------------
// Send As addresses for IMAP inboxes: the rules, without the I/O.
//
// A Send As address lets an IMAP inbox (iCloud, Yahoo, Gmail by app password,
// any SMTP host) put another address in From while it keeps logging in as
// itself. The motivating case is an iCloud alias: Apple refuses the alias as
// an IMAP login, and connecting the primary login a second time is refused by
// imap-login-collision.ts, so before this the alias could not send at all.
//
// WHY EVERY ADDRESS IS VERIFIED. Many SMTP hosts accept any From for an
// authenticated login. An unverified alias would let any workspace member
// send as any address. So adding one mails a 6-digit code TO the alias, and
// the alias becomes usable only when that code comes back: proof that mail
// for the address reaches this user. Only a hash of the code is stored.
//
// WHY THE LIMITS. The verification mail goes to an address the user typed, so
// the add flow is an outbound mailer and is capped like the support form
// (lib/support/rate-limit.ts): per destination address across every
// workspace, and per workspace. The buckets are keyed by address and
// workspace, never by row, so deleting and re-adding an alias resets nothing.
//
// WHY ONLY THE SAME WORKSPACE IS CHECKED for "already a connected inbox". An
// address connected as an inbox in the SAME workspace already sends as itself,
// so an alias for it is a mistake worth naming. In ANOTHER workspace, refusing
// would tell the caller that someone else has connected that address (an
// enumeration oracle), and it buys nothing: the code goes to that mailbox, so
// only its owner can complete the verification.
//
// The actions take a store, a mailer and a rate limiter, so the tests run them
// against memory. send-as-store.ts is the Supabase store.
// ---------------------------------------------------------------------------

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { normalizeSenderName } from '@/lib/inboxes/sender-name';

export const SEND_AS_PROVIDERS: readonly string[] = ['imap'];
export const SEND_AS_MAX_PER_INBOX = 10;
export const SEND_AS_CODE_TTL_MS = 15 * 60 * 1000;
export const SEND_AS_MAX_ATTEMPTS = 5;
export const SEND_AS_RESEND_COOLDOWN_MS = 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Verification mails allowed per bucket. See the header for why per address. */
export const SEND_AS_RATE_LIMITS = [
  { scope: 'to', max: 3, windowMs: HOUR_MS },
  { scope: 'to', max: 6, windowMs: DAY_MS },
  { scope: 'ws', max: 10, windowMs: HOUR_MS },
  { scope: 'ws', max: 30, windowMs: DAY_MS },
] as const;

// Same character rules as the CHECK constraint in 20261018120000: no space,
// control, angle bracket, quote, comma, semicolon or colon anywhere, exactly
// one @, and a dot in the domain. Anything that could break the From header
// is refused here and again by the database.
const ADDRESS_RE = /^[^\s\x00-\x1f\x7f<>(),;:"[\]\\@]+@[^\s\x00-\x1f\x7f<>(),;:"[\]\\@]+\.[^\s\x00-\x1f\x7f<>(),;:"[\]\\@]+$/;
const ADDRESS_MAX = 254;

export function normalizeAliasAddress(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value || value.length > ADDRESS_MAX || !ADDRESS_RE.test(value)) return null;
  return value;
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Bound to the row, so a code for one alias can never verify another. */
export function hashCode(aliasId: string, code: string): string {
  return createHash('sha256').update(`send-as:${aliasId}:${code}`).digest('hex');
}

export function codeMatches(storedHash: string, aliasId: string, code: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(hashCode(aliasId, code), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pasted codes keep only their digits: "123 456" and "123-456" both work. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SendAsInbox {
  id: string;
  workspace_id: string;
  provider: string;
  email_address: string;
  smtp_host: string | null;
}

export interface AliasRow {
  id: string;
  inbox_id: string;
  workspace_id: string;
  email_address: string;
  display_name: string | null;
  verified_at: string | null;
  code_hash: string | null;
  code_expires_at: string | null;
  code_attempts: number;
  code_sent_at: string | null;
  created_at: string;
}

/** What the dashboard is shown. Never the hash or the attempt count. */
export interface PublicAlias {
  id: string;
  email_address: string;
  display_name: string | null;
  verified: boolean;
  code_pending: boolean;
}

export interface SendAsStore {
  list(inbox: SendAsInbox): Promise<AliasRow[]>;
  get(inbox: SendAsInbox, aliasId: string): Promise<AliasRow | null>;
  /** True when `address` is an active inbox of this workspace. */
  isConnectedInbox(workspaceId: string, address: string): Promise<boolean>;
  insert(
    inbox: SendAsInbox,
    row: { email_address: string; display_name: string | null; created_by: string },
  ): Promise<AliasRow>;
  update(inbox: SendAsInbox, aliasId: string, patch: Partial<AliasRow>): Promise<void>;
  remove(inbox: SendAsInbox, aliasId: string): Promise<boolean>;
}

export interface SendAsMailer {
  sendCode(params: { to: string; inboxAddress: string; code: string }): Promise<void>;
}

/** True when the bucket is over its limit (the caller refuses). */
export type RateLimiter = (key: string, max: number, windowMs: number) => Promise<boolean>;

export interface SendAsDeps {
  store: SendAsStore;
  mailer: SendAsMailer;
  rateLimit: RateLimiter;
  now: () => number;
}

export type SendAsError =
  | 'invalid_address'
  | 'invalid_display_name'
  | 'invalid_code'
  | 'unsupported_provider'
  | 'no_smtp'
  | 'own_address'
  | 'connected_inbox'
  | 'already_verified'
  | 'too_many_aliases'
  | 'rate_limited'
  | 'cooldown'
  | 'not_found'
  | 'code_expired'
  | 'too_many_attempts'
  | 'wrong_code'
  | 'mail_failed';

export type SendAsResult<T> = { ok: true; value: T } | { ok: false; error: SendAsError };

/** HTTP status per error. One place, so the route and the tests agree. */
export const SEND_AS_ERROR_STATUS: Record<SendAsError, number> = {
  invalid_address: 400,
  invalid_display_name: 400,
  invalid_code: 400,
  unsupported_provider: 400,
  no_smtp: 400,
  own_address: 400,
  connected_inbox: 409,
  already_verified: 409,
  too_many_aliases: 409,
  rate_limited: 429,
  cooldown: 429,
  not_found: 404,
  code_expired: 410,
  too_many_attempts: 410,
  wrong_code: 400,
  mail_failed: 502,
};

export function toPublicAlias(row: AliasRow, nowMs: number): PublicAlias {
  return {
    id: row.id,
    email_address: row.email_address,
    display_name: row.display_name,
    verified: row.verified_at !== null,
    code_pending:
      row.verified_at === null &&
      row.code_hash !== null &&
      row.code_expires_at !== null &&
      Date.parse(row.code_expires_at) > nowMs &&
      row.code_attempts < SEND_AS_MAX_ATTEMPTS,
  };
}

function supports(inbox: SendAsInbox): SendAsError | null {
  if (!SEND_AS_PROVIDERS.includes(inbox.provider)) return 'unsupported_provider';
  if (!inbox.smtp_host) return 'no_smtp';
  return null;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export async function listAliases(deps: SendAsDeps, inbox: SendAsInbox): Promise<PublicAlias[]> {
  const nowMs = deps.now();
  return (await deps.store.list(inbox)).map((row) => toPublicAlias(row, nowMs));
}

/**
 * Add an address and mail it a code. Re-adding an address that is still
 * unverified sends a fresh code to the same row rather than failing, which is
 * what a user who lost the first mail will try.
 */
export async function addAlias(
  deps: SendAsDeps,
  inbox: SendAsInbox,
  userId: string,
  input: { email_address: unknown; display_name?: unknown },
): Promise<SendAsResult<PublicAlias>> {
  const unsupported = supports(inbox);
  if (unsupported) return { ok: false, error: unsupported };

  const address = normalizeAliasAddress(input.email_address);
  if (!address) return { ok: false, error: 'invalid_address' };

  let displayName: string | null = null;
  if (input.display_name !== undefined && input.display_name !== null) {
    const normalized = normalizeSenderName(input.display_name);
    if (!normalized.ok) return { ok: false, error: 'invalid_display_name' };
    displayName = normalized.value;
  }

  if (address === inbox.email_address.trim().toLowerCase()) return { ok: false, error: 'own_address' };
  if (await deps.store.isConnectedInbox(inbox.workspace_id, address)) {
    return { ok: false, error: 'connected_inbox' };
  }

  const existing = await deps.store.list(inbox);
  let row = existing.find((r) => r.email_address.toLowerCase() === address) ?? null;
  if (row?.verified_at) return { ok: false, error: 'already_verified' };
  if (!row && existing.length >= SEND_AS_MAX_PER_INBOX) return { ok: false, error: 'too_many_aliases' };

  if (!row) {
    row = await deps.store.insert(inbox, { email_address: address, display_name: displayName, created_by: userId });
  } else if (displayName !== null && displayName !== row.display_name) {
    await deps.store.update(inbox, row.id, { display_name: displayName });
    row = { ...row, display_name: displayName };
  }

  return await mailCode(deps, inbox, row);
}

export async function resendCode(
  deps: SendAsDeps,
  inbox: SendAsInbox,
  aliasId: string,
): Promise<SendAsResult<PublicAlias>> {
  const unsupported = supports(inbox);
  if (unsupported) return { ok: false, error: unsupported };
  const row = await deps.store.get(inbox, aliasId);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.verified_at) return { ok: false, error: 'already_verified' };
  return await mailCode(deps, inbox, row);
}

async function mailCode(deps: SendAsDeps, inbox: SendAsInbox, row: AliasRow): Promise<SendAsResult<PublicAlias>> {
  const nowMs = deps.now();
  if (row.code_sent_at && nowMs - Date.parse(row.code_sent_at) < SEND_AS_RESEND_COOLDOWN_MS) {
    return { ok: false, error: 'cooldown' };
  }

  // Every bucket is consulted, so a refused mail still counts against the
  // others: a caller hammering one address also uses up its workspace budget.
  const address = row.email_address.toLowerCase();
  const limited = await Promise.all(
    SEND_AS_RATE_LIMITS.map((l) =>
      deps.rateLimit(
        `send-as:${l.scope}:${l.windowMs}:${l.scope === 'to' ? address : inbox.workspace_id}`,
        l.max,
        l.windowMs,
      ),
    ),
  );
  if (limited.some(Boolean)) return { ok: false, error: 'rate_limited' };

  const code = generateCode();
  const patch: Partial<AliasRow> = {
    code_hash: hashCode(row.id, code),
    code_expires_at: new Date(nowMs + SEND_AS_CODE_TTL_MS).toISOString(),
    code_attempts: 0,
    code_sent_at: new Date(nowMs).toISOString(),
  };
  await deps.store.update(inbox, row.id, patch);

  try {
    await deps.mailer.sendCode({ to: row.email_address, inboxAddress: inbox.email_address, code });
  } catch (err) {
    console.error('[send-as] verification mail failed:', err instanceof Error ? err.message : String(err));
    // Leave no live code nobody received, and no cooldown for a mail that
    // never went.
    await deps.store.update(inbox, row.id, {
      code_hash: null,
      code_expires_at: null,
      code_sent_at: null,
    });
    return { ok: false, error: 'mail_failed' };
  }

  return { ok: true, value: toPublicAlias({ ...row, ...patch }, nowMs) };
}

export async function verifyAlias(
  deps: SendAsDeps,
  inbox: SendAsInbox,
  aliasId: string,
  rawCode: unknown,
): Promise<SendAsResult<PublicAlias>> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: 'invalid_code' };

  const row = await deps.store.get(inbox, aliasId);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.verified_at) return { ok: false, error: 'already_verified' };

  const nowMs = deps.now();
  if (!row.code_hash || !row.code_expires_at || Date.parse(row.code_expires_at) <= nowMs) {
    return { ok: false, error: 'code_expired' };
  }
  if (row.code_attempts >= SEND_AS_MAX_ATTEMPTS) return { ok: false, error: 'too_many_attempts' };

  if (!codeMatches(row.code_hash, row.id, code)) {
    const attempts = row.code_attempts + 1;
    await deps.store.update(inbox, row.id, { code_attempts: attempts });
    return { ok: false, error: attempts >= SEND_AS_MAX_ATTEMPTS ? 'too_many_attempts' : 'wrong_code' };
  }

  const verifiedAt = new Date(nowMs).toISOString();
  const patch: Partial<AliasRow> = {
    verified_at: verifiedAt,
    code_hash: null,
    code_expires_at: null,
    code_attempts: 0,
  };
  await deps.store.update(inbox, row.id, patch);
  return { ok: true, value: toPublicAlias({ ...row, ...patch }, nowMs) };
}

export async function removeAlias(
  deps: SendAsDeps,
  inbox: SendAsInbox,
  aliasId: string,
): Promise<SendAsResult<null>> {
  const removed = await deps.store.remove(inbox, aliasId);
  return removed ? { ok: true, value: null } : { ok: false, error: 'not_found' };
}
