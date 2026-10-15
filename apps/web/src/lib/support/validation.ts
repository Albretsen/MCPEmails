/**
 * Ticket request validation. Pure: no network, no database, no clock except
 * the `nowMs` passed in. The route maps the result straight onto a response.
 *
 * Caps are mirrored by CHECK constraints in
 * supabase/migrations/20261016090000_support_tickets.sql; change both together.
 */
import { checkSupportFormToken } from '@/lib/support/form-token';

export const SUPPORT_CATEGORIES = ['connect', 'client', 'billing', 'bug', 'feature', 'other'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

/** English labels for the support inbox (subject line and context block). */
export const SUPPORT_CATEGORY_LABELS: Record<SupportCategory, string> = {
  connect: 'Connecting a mailbox',
  client: 'AI client',
  billing: 'Billing',
  bug: 'Bug',
  feature: 'Feature request',
  other: 'Other',
};

export const SUPPORT_LIMITS = {
  email: 254,
  subject: 150,
  message: 5000,
  slug: 64,
} as const;

export type SupportTicketErrorCode =
  | 'invalid_json'
  | 'invalid_email'
  | 'invalid_category'
  | 'subject_required'
  | 'subject_too_long'
  | 'message_required'
  | 'message_too_long'
  | 'invalid_form_token';

export type SupportTicketSource = 'form_signed_in' | 'form_signed_out';

export interface ValidTicket {
  email: string;
  category: SupportCategory;
  subject: string;
  message: string;
  source: SupportTicketSource;
  from: string | null;
  provider: string | null;
  code: string | null;
}

export type ValidationResult =
  | { kind: 'ok'; ticket: ValidTicket }
  | { kind: 'drop' }
  | { kind: 'error'; error: SupportTicketErrorCode };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SLUG_RE = /^[a-z0-9_.-]+$/;

/** A context slug (`from`, `provider`, `code`): lowercased, capped, else dropped. */
export function sanitizeSlug(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v.length > SUPPORT_LIMITS.slug || !SLUG_RE.test(v)) return null;
  return v;
}

/** Trimmed, lowercased, syntactically plausible address within the cap; else null. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v.length > SUPPORT_LIMITS.email || !EMAIL_RE.test(v)) return null;
  return v;
}

/** Strips NULs and other C0 controls except newline and tab; normalises CRLF. */
function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

/**
 * Order of checks: honeypot and form token first (a bot gets its silent 200
 * before anything else is looked at), then fields in form order so the first
 * error the visitor sees is the topmost field.
 */
export function validateTicketRequest(
  raw: unknown,
  opts: { sessionEmail: string | null; nowMs: number },
): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'error', error: 'invalid_json' };
  const body = raw as Record<string, unknown>;

  if (body.website !== undefined && body.website !== null && body.website !== '') return { kind: 'drop' };

  const token = checkSupportFormToken(body.formToken, opts.nowMs);
  if (token === 'too_fast') return { kind: 'drop' };
  if (token !== 'ok') return { kind: 'error', error: 'invalid_form_token' };

  // Signed in: the session is the identity, whatever the body says.
  const email = opts.sessionEmail ? normalizeEmail(opts.sessionEmail) : normalizeEmail(body.email);
  if (!email) return { kind: 'error', error: 'invalid_email' };

  const category = body.category;
  if (typeof category !== 'string' || !(SUPPORT_CATEGORIES as readonly string[]).includes(category)) {
    return { kind: 'error', error: 'invalid_category' };
  }

  const subject = typeof body.subject === 'string' ? cleanText(body.subject).replace(/\s*\n\s*/g, ' ') : '';
  if (!subject) return { kind: 'error', error: 'subject_required' };
  if (subject.length > SUPPORT_LIMITS.subject) return { kind: 'error', error: 'subject_too_long' };

  const message = typeof body.message === 'string' ? cleanText(body.message) : '';
  if (!message) return { kind: 'error', error: 'message_required' };
  if (message.length > SUPPORT_LIMITS.message) return { kind: 'error', error: 'message_too_long' };

  return {
    kind: 'ok',
    ticket: {
      email,
      category: category as SupportCategory,
      subject,
      message,
      source: opts.sessionEmail ? 'form_signed_in' : 'form_signed_out',
      from: sanitizeSlug(body.from),
      provider: sanitizeSlug(body.provider),
      code: sanitizeSlug(body.code),
    },
  };
}
