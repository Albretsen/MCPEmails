/**
 * Server side of the /onboarding steps after the inbox (WP-F): the funnel
 * vocabulary POST /api/onboarding/assist accepts, the three service emails
 * the flow can send (setup link, help steps, tomorrow's morning brief), and
 * when "tomorrow at 8" is in the user's own time zone.
 *
 * Copy comes from messages/<locale>/onboarding.json (`emails.*`, `prompts.*`,
 * `help.*`), read here directly: route handlers have no next-intl request
 * scope, and the files are small.
 */
import en from '../../../messages/en/onboarding.json' with { type: 'json' };
import de from '../../../messages/de/onboarding.json' with { type: 'json' };
import fr from '../../../messages/fr/onboarding.json' with { type: 'json' };
import es from '../../../messages/es/onboarding.json' with { type: 'json' };
import nb from '../../../messages/nb/onboarding.json' with { type: 'json' };
import zh from '../../../messages/zh/onboarding.json' with { type: 'json' };
import { CHIP_CLIENT_LABELS, normalizeChipClient } from './clients.mjs';
import { HELP_TIERS, LINK_KINDS, PROMPT_KINDS, docsPath, promptKeys, restartKind } from './connect-steps.mjs';

export type HelpTier = 'no_handshake' | 'no_call' | 'reconnect';
export type PromptKind = 'reply_radar' | 'draft_replies' | 'morning_brief';
export type LinkKind = 'add_to_ai' | 'help_steps';

/** product_funnel_events.category values this file adds (migration 20261026221917). */
export type OnboardingAssistCategory =
  | 'help_no_handshake' | 'help_no_call' | 'help_reconnect'
  | 'prompt_reply_radar' | 'prompt_draft_replies' | 'prompt_morning_brief'
  | 'link_add_to_ai' | 'link_help_steps';

export const ASSIST_LOCALES = ['en', 'de', 'fr', 'es', 'nb', 'zh'] as const;
export type AssistLocale = (typeof ASSIST_LOCALES)[number];

export function assistLocale(value: unknown): AssistLocale {
  const base = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
  return (ASSIST_LOCALES as readonly string[]).includes(base) ? (base as AssistLocale) : 'en';
}

export function isHelpTier(value: unknown): value is HelpTier {
  return typeof value === 'string' && (HELP_TIERS as readonly string[]).includes(value);
}
export function isPromptKind(value: unknown): value is PromptKind {
  return typeof value === 'string' && (PROMPT_KINDS as readonly string[]).includes(value);
}
export function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === 'string' && (LINK_KINDS as readonly string[]).includes(value);
}

/**
 * One browser-reported funnel event, narrowed to the closed lists:
 *   handshake_seen       {client}   the ladder saw the MCP handshake
 *   help_shown           {tier}     a timed help panel opened
 *   prompt_copied        {prompt}   a prompt's Copy button
 *   open_client_clicked  {client}   "Open Claude" / "Open ChatGPT"
 * Returns the row's stage + category, or null for anything else.
 */
export function assistEvent(body: Record<string, unknown>): { stage: 'onboarding_handshake_seen' | 'onboarding_help_shown' | 'onboarding_prompt_copied' | 'onboarding_open_client_clicked'; category: string } | null {
  const client = normalizeChipClient(body.client);
  switch (body.event) {
    case 'handshake_seen':
      return { stage: 'onboarding_handshake_seen', category: client ?? 'unknown' };
    case 'open_client_clicked':
      return client ? { stage: 'onboarding_open_client_clicked', category: client } : null;
    case 'help_shown':
      return isHelpTier(body.tier) ? { stage: 'onboarding_help_shown', category: `help_${body.tier}` } : null;
    case 'prompt_copied':
      return isPromptKind(body.prompt) ? { stage: 'onboarding_prompt_copied', category: `prompt_${body.prompt}` } : null;
    default:
      return null;
  }
}

// ── Copy ────────────────────────────────────────────────────────────────────

type Messages = typeof en;
const MESSAGES: Record<AssistLocale, Messages> = { en, de, fr, es, nb, zh } as Record<AssistLocale, Messages>;

/** A dotted key out of onboarding.json, with {var} filled in. Falls back to English. */
export function onboardingText(locale: AssistLocale, key: string, vars: Record<string, string> = {}): string {
  const read = (root: unknown) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), root);
  const raw = read(MESSAGES[locale]) ?? read(MESSAGES.en);
  const text = typeof raw === 'string' ? raw : key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? vars[name] : match));
}

export interface ServiceEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain paragraphs (a URL alone on its line becomes a link, a quoted block a box). */
function compose(subject: string, blocks: Array<{ kind: 'p' | 'link' | 'quote'; text: string }>): ServiceEmail {
  const text = blocks.map((b) => b.text).join('\n\n');
  const html = blocks.map((b) => {
    const t = escapeHtml(b.text);
    if (b.kind === 'link') return `<p><a href="${t}">${t}</a></p>`;
    if (b.kind === 'quote') return `<p style="background:#f4f4f5;border-radius:6px;padding:12px 14px;font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap">${t}</p>`;
    return `<p>${t}</p>`;
  }).join('\n');
  return { subject, text, html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b">${html}</div>` };
}

function label(client: string | null): string {
  return CHIP_CLIENT_LABELS[(normalizeChipClient(client) ?? 'claude') as keyof typeof CHIP_CLIENT_LABELS];
}

/** "Email me this link": the add-to-AI step, resumable on a computer. */
export function setupLinkEmail(locale: AssistLocale, client: string, appUrl: string): ServiceEmail {
  const id = normalizeChipClient(client) ?? 'claude';
  const name = label(id);
  const link = `${appUrl}/onboarding?step=add_to_ai&client=${id}`;
  return compose(onboardingText(locale, 'emails.setupLink.subject'), [
    { kind: 'p', text: onboardingText(locale, 'emails.setupLink.intro', { client: name }) },
    { kind: 'link', text: link },
    { kind: 'p', text: onboardingText(locale, 'emails.footer') },
  ]);
}

/** "Email me the steps": the 10-minute help, as an email. */
export function helpStepsEmail(locale: AssistLocale, client: string, appUrl: string): ServiceEmail {
  const id = normalizeChipClient(client) ?? 'claude';
  const name = label(id);
  const vars = { client: name };
  const restart = restartKind(id);
  const noCall = id === 'claude' || id === 'chatgpt' ? id : 'other';
  const prompt = promptKeys(id).replyRadar;
  const blocks: Array<{ kind: 'p' | 'link' | 'quote'; text: string }> = [
    { kind: 'p', text: onboardingText(locale, 'emails.helpSteps.intro', vars) },
    { kind: 'p', text: `1. ${onboardingText(locale, `help.noHandshake.${restart}`, vars)}` },
    { kind: 'p', text: `2. ${onboardingText(locale, `help.noCall.${noCall}`, vars)}` },
    { kind: 'p', text: `3. ${onboardingText(locale, 'help.reconnect.body', vars)}` },
  ];
  if (prompt) {
    blocks.push({ kind: 'p', text: onboardingText(locale, 'emails.helpSteps.prompt') });
    blocks.push({ kind: 'quote', text: onboardingText(locale, prompt) });
  }
  blocks.push({ kind: 'p', text: onboardingText(locale, 'emails.helpSteps.guide') });
  blocks.push({ kind: 'link', text: `${appUrl}${docsPath(id)}` });
  blocks.push({ kind: 'p', text: onboardingText(locale, 'emails.helpSteps.resume') });
  blocks.push({ kind: 'link', text: `${appUrl}/onboarding?client=${id}` });
  blocks.push({ kind: 'p', text: onboardingText(locale, 'emails.footer') });
  return compose(onboardingText(locale, 'emails.helpSteps.subject', vars), blocks);
}

/** The one morning email: the Morning brief prompt for the client they use. */
export function morningBriefEmail(locale: AssistLocale, client: string | null): ServiceEmail {
  const id = normalizeChipClient(client) ?? 'claude';
  const key = promptKeys(id).morningBrief ?? 'prompts.morningBrief.chat';
  return compose(onboardingText(locale, 'emails.morning.subject'), [
    { kind: 'p', text: onboardingText(locale, 'emails.morning.intro', { client: label(id) }) },
    { kind: 'quote', text: onboardingText(locale, key) },
    { kind: 'p', text: onboardingText(locale, 'emails.footer') },
  ]);
}

// ── Tomorrow at 8 ───────────────────────────────────────────────────────────

/** A valid IANA zone, or null. */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** Wall-clock parts of `ms` in `timeZone`. */
function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** The UTC instant of a wall-clock time in a zone (DST-safe to the hour). */
function zonedToUtc(y: number, m: number, d: number, h: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d, h, 0, 0);
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, timeZone);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const want = Date.UTC(y, m - 1, d, h, 0, 0);
    if (shown === want) break;
    guess += want - shown;
  }
  return guess;
}

/** 08:00 tomorrow in `timeZone`, as a UTC instant. */
export function tomorrowAtEight(nowMs: number, timeZone: string): Date {
  const today = zonedParts(nowMs, timeZone);
  const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  return new Date(zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 8, timeZone));
}
