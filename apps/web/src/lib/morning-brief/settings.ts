/**
 * Morning brief settings (Pro feature `morning_brief`): the validation the
 * dashboard route applies before it writes public.morning_briefs.
 *
 * Mirror of the settings rules in
 * supabase/functions/mcp-server/morning-brief-engine.ts (normalizeVipEntry,
 * isValidTimeZone, BRIEF_LOCALES, BRIEF_MAX_VIP_ENTRIES). The dispatcher
 * re-validates what it reads, so a drift here can only refuse, never break a
 * brief.
 */

export const MORNING_BRIEF_LOCALES = ['en', 'nb', 'fr', 'es', 'de'] as const;
export type MorningBriefLocale = (typeof MORNING_BRIEF_LOCALES)[number];

export const MORNING_BRIEF_MAX_VIP = 50;
export const MORNING_BRIEF_MAX_VIP_LENGTH = 254;
export const MORNING_BRIEF_DEFAULT_HOUR = 7;

export interface MorningBriefSettings {
  enabled: boolean;
  hour: number;
  timezone: string;
  locale: MorningBriefLocale;
  inbox_id: string | null;
  vip_senders: string[];
}

export type SettingsError =
  | 'invalid_request'
  | 'invalid_enabled'
  | 'invalid_hour'
  | 'invalid_timezone'
  | 'invalid_locale'
  | 'invalid_inbox'
  | 'invalid_vip'
  | 'too_many_vips'
  | 'inbox_required';

export type Normalized = { ok: true; value: MorningBriefSettings } | { ok: false; error: SettingsError; detail?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>()",;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** An address or a domain ("@example.com" and "example.com" are the same); null when invalid. */
export function normalizeVipEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v.length > MORNING_BRIEF_MAX_VIP_LENGTH) return null;
  if (v.includes('@') && !v.startsWith('@')) return EMAIL_RE.test(v) ? v : null;
  const domain = v.startsWith('@') ? v.slice(1) : v;
  return DOMAIN_RE.test(domain) ? domain : null;
}

/** Split the textarea the dashboard sends (commas, spaces or new lines). */
export function splitVipText(text: string): string[] {
  return text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** The defaults a workspace without a row shows. */
export function defaultMorningBriefSettings(): MorningBriefSettings {
  return { enabled: false, hour: MORNING_BRIEF_DEFAULT_HOUR, timezone: 'UTC', locale: 'en', inbox_id: null, vip_senders: [] };
}

/** Validate a PUT body. Every field is required, so a save is always the whole form. */
export function normalizeMorningBriefInput(body: unknown): Normalized {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'invalid_request' };
  const b = body as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'invalid_enabled' };
  if (typeof b.hour !== 'number' || !Number.isInteger(b.hour) || b.hour < 0 || b.hour > 23) {
    return { ok: false, error: 'invalid_hour' };
  }
  if (!isValidTimeZone(b.timezone)) return { ok: false, error: 'invalid_timezone' };
  if (typeof b.locale !== 'string' || !(MORNING_BRIEF_LOCALES as readonly string[]).includes(b.locale)) {
    return { ok: false, error: 'invalid_locale' };
  }
  let inboxId: string | null = null;
  if (b.inbox_id !== null && b.inbox_id !== undefined && b.inbox_id !== '') {
    if (typeof b.inbox_id !== 'string' || !UUID_RE.test(b.inbox_id)) return { ok: false, error: 'invalid_inbox' };
    inboxId = b.inbox_id.toLowerCase();
  }
  if (b.enabled && !inboxId) return { ok: false, error: 'inbox_required' };
  if (!Array.isArray(b.vip_senders)) return { ok: false, error: 'invalid_vip' };
  const vips: string[] = [];
  for (const entry of b.vip_senders) {
    const v = normalizeVipEntry(entry);
    if (!v) return { ok: false, error: 'invalid_vip', detail: typeof entry === 'string' ? entry.slice(0, 80) : undefined };
    if (!vips.includes(v)) vips.push(v);
  }
  if (vips.length > MORNING_BRIEF_MAX_VIP) return { ok: false, error: 'too_many_vips' };
  return {
    ok: true,
    value: {
      enabled: b.enabled,
      hour: b.hour,
      timezone: b.timezone,
      locale: b.locale as MorningBriefLocale,
      inbox_id: inboxId,
      vip_senders: vips,
    },
  };
}
