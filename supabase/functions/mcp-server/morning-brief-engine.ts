// ---------------------------------------------------------------------------
// morning-brief-engine.ts - the Pro "morning_brief" feature: a daily,
// rules-based summary per workspace, put straight into one of the owner's own
// inboxes. No model anywhere.
//
// Table public.morning_briefs (migration 20261024214000), one row per
// workspace, written by the dashboard route (settings) and by the dispatcher
// (schedule, outcome, lease).
//
// What a brief holds, for the owner's local day at the chosen hour:
//   * VIP senders first: new mail from an address or domain on the owner's list;
//   * new mail per inbox since the last brief (count, newest few senders and
//     subjects);
//   * follow-ups that became due (public.reminders, kind follow_up, status due);
//   * snoozed mail coming back later today (kind snooze, pending, due today);
//   * scheduled sends due later today (public.scheduled_sends, pending).
// When every section is empty the brief is skipped, not sent.
//
// Delivery is NOT a send: index.ts inserts the message into the chosen inbox
// (IMAP APPEND to INBOX unseen, Gmail messages.insert, Graph create in the
// inbox folder). Nothing leaves the user's mailbox, nothing is metered.
//
// Pure module: the time zone math, the settings rules, the content builder and
// the dispatcher loop over injected `MorningBriefDeps`. index.ts supplies the
// Supabase queries and the provider seams. Same split as reminders-engine.ts.
// ---------------------------------------------------------------------------

import { neutralizeText } from "./text-safety.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ── Limits ─────────────────────────────────────────────────────────────────

/** A brief is sent up to this long after its hour; later, that day is skipped. */
export const BRIEF_GRACE_MS = 3 * HOUR;
/** Inboxes read per brief (the newest-connected beyond this are left out). */
export const BRIEF_MAX_INBOXES = 10;
/** Messages listed per inbox when counting new mail; more shows as "N+". */
export const BRIEF_LIST_LIMIT = 25;
/** Newest messages shown per inbox (VIP mail is shown in its own section). */
export const BRIEF_NEWEST_PER_INBOX = 3;
/** VIP messages shown, across inboxes. */
export const BRIEF_MAX_VIP_ITEMS = 10;
/** Rows shown per reminder / schedule section. */
export const BRIEF_MAX_SECTION_ITEMS = 10;
/** "New since" never reaches further back than this. */
export const BRIEF_MAX_LOOKBACK_MS = 7 * DAY;
/** "New since" for the very first brief. */
export const BRIEF_FIRST_LOOKBACK_MS = DAY;
/** VIP list size and entry length (the web route enforces the same). */
export const BRIEF_MAX_VIP_ENTRIES = 50;
export const BRIEF_MAX_VIP_ENTRY_LENGTH = 254;

/** Dispatcher bounds. */
export const BRIEF_STALE_LEASE_MS = 10 * MINUTE;
export const BRIEF_TIME_BUDGET_MS = 45_000;
export const MAX_BRIEFS_PER_INVOCATION = 20;
export const BRIEF_DUE_SCAN_LIMIT = 50;
export const BRIEF_MAX_CONSECUTIVE_FAILURES = 5;
export const BRIEF_FAILURE_BACKOFF_MS: readonly number[] = [5 * MINUTE, 15 * MINUTE, HOUR, 2 * HOUR];

/** The display name the brief comes from, and how a later brief recognises it. */
export const BRIEF_FROM_NAME = "MCPEmails Brief";

export const BRIEF_LOCALES = ["en", "nb", "fr", "es", "de"] as const;
export type BriefLocale = (typeof BRIEF_LOCALES)[number];

export function isBriefLocale(value: unknown): value is BriefLocale {
  return typeof value === "string" && (BRIEF_LOCALES as readonly string[]).includes(value);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── Time zones ─────────────────────────────────────────────────────────────

/** Whether Intl knows this IANA zone. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `ms`. */
export function wallClock(ms: number, tz: string): WallClock {
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = Number(get("hour")) % 24;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")) };
}

/** The local calendar date in `tz` at instant `ms`, as YYYY-MM-DD. */
export function localDateOf(ms: number, tz: string): string {
  return wallClock(ms, tz).date;
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Oslo in summer: +2 h). */
function offsetAt(ms: number, tz: string): number {
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** YYYY-MM-DD plus `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function wallKey(w: WallClock): string {
  return `${w.date}T${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/**
 * The instant the wall clock in `tz` first reads `date` `hour`:00.
 *
 * DST: on a spring-forward day an hour inside the gap (02:30 does not exist in
 * Oslo on the last Sunday of March) resolves to the first instant after the gap
 * (03:00 local). On a fall-back day an hour that happens twice resolves to the
 * first time it happens.
 */
export function zonedInstant(date: string, hour: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  const target = `${date}T${String(hour).padStart(2, "0")}:00`;
  const offsets = new Set([offsetAt(naive - DAY, tz), offsetAt(naive, tz), offsetAt(naive + DAY, tz)]);
  let best: number | null = null;
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (wallKey(wallClock(candidate, tz)) >= target && (best === null || candidate < best)) best = candidate;
  }
  return best ?? naive;
}

export interface BriefSlot {
  /** The local date the brief is for. */
  localDate: string;
  /** When it is due (the hour on that date, in the zone). */
  slotMs: number;
}

/**
 * The next brief this row should get: the earliest local date after
 * `lastLocalDate` whose slot has not slipped past the grace window. Yesterday
 * is included so a late-evening hour can still be served after midnight UTC.
 */
export function nextBriefSlot(nowMs: number, hour: number, tz: string, lastLocalDate: string | null): BriefSlot {
  const today = localDateOf(nowMs, tz);
  for (let i = -1; i <= 3; i++) {
    const localDate = addDays(today, i);
    if (lastLocalDate && localDate <= lastLocalDate) continue;
    const slotMs = zonedInstant(localDate, hour, tz);
    if (slotMs + BRIEF_GRACE_MS <= nowMs) continue;
    return { localDate, slotMs };
  }
  // Unreachable for a valid zone; a day from now keeps the row moving.
  const localDate = addDays(today, 1);
  return { localDate, slotMs: zonedInstant(localDate, hour, tz) };
}

/** Start of the local day after `date` in `tz`: the "today" window's end. */
export function endOfLocalDay(date: string, tz: string): number {
  return zonedInstant(addDays(date, 1), 0, tz);
}

// ── Settings ───────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@<>()",;:]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** One VIP entry: an address or a domain ("@example.com" and "example.com" are the same). */
export function normalizeVipEntry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v.length > BRIEF_MAX_VIP_ENTRY_LENGTH) return null;
  if (v.includes("@") && !v.startsWith("@")) return EMAIL_RE.test(v) ? v : null;
  const domain = v.startsWith("@") ? v.slice(1) : v;
  return DOMAIN_RE.test(domain) ? domain : null;
}

/** The VIP list, deduplicated, invalid entries dropped. Mirrors the web route. */
export function normalizeVipList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const v = normalizeVipEntry(entry);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= BRIEF_MAX_VIP_ENTRIES) break;
  }
  return out;
}

/** Whether a sender address matches the list: exact address, or the domain or a subdomain of it. */
export function isVipSender(address: string | null | undefined, vips: readonly string[]): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return false;
  const domain = a.slice(at + 1);
  for (const vip of vips) {
    if (vip.includes("@")) {
      if (a === vip) return true;
    } else if (domain === vip || domain.endsWith(`.${vip}`)) {
      return true;
    }
  }
  return false;
}

// ── The content ────────────────────────────────────────────────────────────

export interface BriefMessage {
  fromName: string;
  fromEmail: string;
  subject: string;
  /** ISO time it arrived. */
  date: string;
}

export interface BriefInboxData {
  address: string;
  /** New messages counted (up to BRIEF_LIST_LIMIT). */
  count: number;
  /** True when the list was full: there may be more than `count`. */
  more: boolean;
  /** Newest first, already filtered to "since". */
  messages: BriefMessage[];
  /** Set when the inbox could not be read (a short code). */
  error?: string | null;
}

export interface BriefReminderItem {
  subject: string;
  /** Recipients (follow-up) or sender (snooze). */
  people: string[];
  /** ISO due time. */
  at: string;
  inbox: string;
}

export interface BriefData {
  inboxes: BriefInboxData[];
  followUps: BriefReminderItem[];
  snoozes: BriefReminderItem[];
  scheduled: BriefReminderItem[];
}

export interface BriefOptions {
  locale: BriefLocale;
  timezone: string;
  /** The local date the brief is for. */
  localDate: string;
  /** "New since" instant, for the heading. */
  sinceMs: number;
  vips: readonly string[];
  /** https://mcpemails.com, no trailing slash. */
  appUrl: string;
}

export interface BuiltBrief {
  empty: boolean;
  subject: string;
  text: string;
  html: string;
  counts: { newMail: number; vip: number; followUps: number; snoozes: number; scheduled: number };
}

interface BriefStrings {
  subject: (date: string) => string;
  heading: (date: string) => string;
  vip: string;
  newMail: (since: string) => string;
  inboxCount: (n: number, more: boolean) => string;
  inboxUnreadable: string;
  noNewMail: string;
  followUps: string;
  followUpLine: (subject: string, to: string, due: string) => string;
  snoozes: string;
  snoozeLine: (subject: string, from: string, at: string) => string;
  scheduled: string;
  scheduledLine: (subject: string, to: string, at: string) => string;
  noSubject: string;
  inInbox: (inbox: string) => string;
  openDashboard: string;
  manage: string;
  footer: string;
}

const plus = (n: number, more: boolean) => `${n}${more ? "+" : ""}`;

const STRINGS: Record<BriefLocale, BriefStrings> = {
  en: {
    subject: (d) => `Morning brief, ${d}`,
    heading: (d) => `Your morning brief for ${d}`,
    vip: "VIP senders",
    newMail: (s) => `New mail since ${s}`,
    inboxCount: (n, more) => `${plus(n, more)} new`,
    inboxUnreadable: "could not be read. Check the connection in the dashboard.",
    noNewMail: "No new mail.",
    followUps: "Follow-ups due",
    followUpLine: (s, to, due) => `${s} to ${to}, due ${due}`,
    snoozes: "Snoozed mail coming back today",
    snoozeLine: (s, from, at) => `${s} from ${from}, at ${at}`,
    scheduled: "Scheduled sends today",
    scheduledLine: (s, to, at) => `${s} to ${to}, at ${at}`,
    noSubject: "(no subject)",
    inInbox: (i) => `in ${i}`,
    openDashboard: "Open the dashboard",
    manage: "Change or turn off this brief",
    footer: "MCPEmails put this brief in your inbox. It was not sent as an email.",
  },
  nb: {
    subject: (d) => `Morgenoversikt, ${d}`,
    heading: (d) => `Morgenoversikten din for ${d}`,
    vip: "VIP-avsendere",
    newMail: (s) => `Ny e-post siden ${s}`,
    inboxCount: (n, more) => `${plus(n, more)} nye`,
    inboxUnreadable: "kunne ikke leses. Sjekk tilkoblingen i dashbordet.",
    noNewMail: "Ingen ny e-post.",
    followUps: "Oppfølginger som har forfalt",
    followUpLine: (s, to, due) => `${s} til ${to}, forfalt ${due}`,
    snoozes: "Utsatt e-post som kommer tilbake i dag",
    snoozeLine: (s, from, at) => `${s} fra ${from}, kl. ${at}`,
    scheduled: "Planlagte sendinger i dag",
    scheduledLine: (s, to, at) => `${s} til ${to}, kl. ${at}`,
    noSubject: "(uten emne)",
    inInbox: (i) => `i ${i}`,
    openDashboard: "Åpne dashbordet",
    manage: "Endre eller slå av denne oversikten",
    footer: "MCPEmails la denne oversikten i innboksen din. Den ble ikke sendt som e-post.",
  },
  fr: {
    subject: (d) => `Brief du matin, ${d}`,
    heading: (d) => `Votre brief du matin pour le ${d}`,
    vip: "Expéditeurs VIP",
    newMail: (s) => `Nouveaux e-mails depuis ${s}`,
    inboxCount: (n, more) => `${plus(n, more)} nouveaux`,
    inboxUnreadable: "n'a pas pu être lue. Vérifiez la connexion dans le tableau de bord.",
    noNewMail: "Aucun nouvel e-mail.",
    followUps: "Relances arrivées à échéance",
    followUpLine: (s, to, due) => `${s} à ${to}, échéance ${due}`,
    snoozes: "E-mails en attente qui reviennent aujourd'hui",
    snoozeLine: (s, from, at) => `${s} de ${from}, à ${at}`,
    scheduled: "Envois programmés aujourd'hui",
    scheduledLine: (s, to, at) => `${s} à ${to}, à ${at}`,
    noSubject: "(sans objet)",
    inInbox: (i) => `dans ${i}`,
    openDashboard: "Ouvrir le tableau de bord",
    manage: "Modifier ou désactiver ce brief",
    footer: "MCPEmails a déposé ce brief dans votre boîte de réception. Il n'a pas été envoyé par e-mail.",
  },
  es: {
    subject: (d) => `Resumen matinal, ${d}`,
    heading: (d) => `Tu resumen matinal del ${d}`,
    vip: "Remitentes VIP",
    newMail: (s) => `Correo nuevo desde ${s}`,
    inboxCount: (n, more) => `${plus(n, more)} nuevos`,
    inboxUnreadable: "no se pudo leer. Revisa la conexión en el panel.",
    noNewMail: "No hay correo nuevo.",
    followUps: "Seguimientos vencidos",
    followUpLine: (s, to, due) => `${s} a ${to}, vencido el ${due}`,
    snoozes: "Correo pospuesto que vuelve hoy",
    snoozeLine: (s, from, at) => `${s} de ${from}, a las ${at}`,
    scheduled: "Envíos programados para hoy",
    scheduledLine: (s, to, at) => `${s} a ${to}, a las ${at}`,
    noSubject: "(sin asunto)",
    inInbox: (i) => `en ${i}`,
    openDashboard: "Abrir el panel",
    manage: "Cambiar o desactivar este resumen",
    footer: "MCPEmails dejó este resumen en tu bandeja de entrada. No se envió como correo.",
  },
  de: {
    subject: (d) => `Morgenübersicht, ${d}`,
    heading: (d) => `Ihre Morgenübersicht für ${d}`,
    vip: "VIP-Absender",
    newMail: (s) => `Neue E-Mails seit ${s}`,
    inboxCount: (n, more) => `${plus(n, more)} neu`,
    inboxUnreadable: "konnte nicht gelesen werden. Prüfen Sie die Verbindung im Dashboard.",
    noNewMail: "Keine neuen E-Mails.",
    followUps: "Fällige Nachfassaktionen",
    followUpLine: (s, to, due) => `${s} an ${to}, fällig ${due}`,
    snoozes: "Zurückgestellte E-Mails, die heute zurückkommen",
    snoozeLine: (s, from, at) => `${s} von ${from}, um ${at}`,
    scheduled: "Geplante Sendungen heute",
    scheduledLine: (s, to, at) => `${s} an ${to}, um ${at}`,
    noSubject: "(kein Betreff)",
    inInbox: (i) => `in ${i}`,
    openDashboard: "Dashboard öffnen",
    manage: "Diese Übersicht ändern oder abschalten",
    footer: "MCPEmails hat diese Übersicht in Ihren Posteingang gelegt. Sie wurde nicht als E-Mail versendet.",
  },
};

const INTL_LOCALE: Record<BriefLocale, string> = { en: "en-GB", nb: "nb-NO", fr: "fr-FR", es: "es-ES", de: "de-DE" };

/** Mailbox text as shown: invisible characters out, whitespace folded, length capped. */
export function briefText(value: string | null | undefined, max = 120): string {
  const clean = neutralizeText(String(value ?? "")).replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sender(m: BriefMessage): string {
  const name = briefText(m.fromName, 60);
  const email = briefText(m.fromEmail, 120);
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} (${email})`;
  return name || email;
}

/**
 * Build the brief. Pure: the same data and options always give the same text,
 * subject and HTML (the golden test pins them). The HTML is plain markup with
 * every mailbox string escaped; index.ts runs it through sanitizeEmailHtml too.
 */
export function buildBrief(data: BriefData, opts: BriefOptions): BuiltBrief {
  const s = STRINGS[opts.locale] ?? STRINGS.en;
  const loc = INTL_LOCALE[opts.locale] ?? "en-GB";
  const tz = opts.timezone;
  const [y, m, d] = opts.localDate.split("-").map(Number);
  // Noon UTC of the date names the right weekday in every zone.
  const dateLabel = new Intl.DateTimeFormat(loc, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
  const time = (ms: number) =>
    new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(ms));
  const dayTime = (ms: number) =>
    new Intl.DateTimeFormat(loc, { weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz })
      .format(new Date(ms));
  const day = (ms: number) =>
    new Intl.DateTimeFormat(loc, { day: "numeric", month: "long", timeZone: tz }).format(new Date(ms));
  const subj = (v: string) => briefText(v) || s.noSubject;
  const people = (list: string[]) => list.map((p) => briefText(p, 120)).filter(Boolean).slice(0, 3).join(", ") || "-";

  // VIP first, across inboxes, newest first.
  const vipItems: { m: BriefMessage; inbox: string }[] = [];
  for (const inbox of data.inboxes) {
    for (const msg of inbox.messages) if (isVipSender(msg.fromEmail, opts.vips)) vipItems.push({ m: msg, inbox: inbox.address });
  }
  vipItems.sort((a, b) => Date.parse(b.m.date) - Date.parse(a.m.date));
  const vipShown = vipItems.slice(0, BRIEF_MAX_VIP_ITEMS);

  const newMail = data.inboxes.reduce((n, i) => n + (i.error ? 0 : i.count), 0);
  const followUps = data.followUps.slice(0, BRIEF_MAX_SECTION_ITEMS);
  const snoozes = data.snoozes.slice(0, BRIEF_MAX_SECTION_ITEMS);
  const scheduled = data.scheduled.slice(0, BRIEF_MAX_SECTION_ITEMS);
  const counts = {
    newMail,
    vip: vipItems.length,
    followUps: data.followUps.length,
    snoozes: data.snoozes.length,
    scheduled: data.scheduled.length,
  };
  const empty = newMail === 0 && followUps.length === 0 && snoozes.length === 0 && scheduled.length === 0;

  const text: string[] = [];
  const html: string[] = [];
  const heading = s.heading(dateLabel);
  text.push(heading, "");
  html.push(`<h2>${escapeHtml(heading)}</h2>`);

  const section = (title: string, lines: { text: string; sub?: string[] }[]) => {
    if (lines.length === 0) return;
    text.push(title);
    html.push(`<h3>${escapeHtml(title)}</h3>`, "<ul>");
    for (const line of lines) {
      text.push(`- ${line.text}`);
      for (const sub of line.sub ?? []) text.push(`  - ${sub}`);
      const subHtml = line.sub && line.sub.length
        ? `<ul>${line.sub.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`
        : "";
      html.push(`<li>${escapeHtml(line.text)}${subHtml}</li>`);
    }
    text.push("");
    html.push("</ul>");
  };

  section(
    s.vip,
    vipShown.map(({ m: msg, inbox }) => ({
      text: `${sender(msg)}: ${subj(msg.subject)} (${s.inInbox(inbox)}, ${time(Date.parse(msg.date))})`,
    })),
  );

  const inboxLines = data.inboxes.map((inbox) => {
    const address = briefText(inbox.address, 120);
    if (inbox.error) return { text: `${address}: ${s.inboxUnreadable}` };
    if (inbox.count === 0) return { text: `${address}: ${s.noNewMail}` };
    const nonVip = inbox.messages.filter((msg) => !isVipSender(msg.fromEmail, opts.vips));
    return {
      text: `${address}: ${s.inboxCount(inbox.count, inbox.more)}`,
      sub: nonVip.slice(0, BRIEF_NEWEST_PER_INBOX).map((msg) => `${sender(msg)}: ${subj(msg.subject)}`),
    };
  });
  if (newMail > 0 || data.inboxes.some((i) => i.error)) section(s.newMail(dayTime(opts.sinceMs)), inboxLines);

  section(
    s.followUps,
    followUps.map((f) => ({ text: `${s.followUpLine(subj(f.subject), people(f.people), day(Date.parse(f.at)))} (${s.inInbox(briefText(f.inbox))})` })),
  );
  section(
    s.snoozes,
    snoozes.map((f) => ({ text: `${s.snoozeLine(subj(f.subject), people(f.people), time(Date.parse(f.at)))} (${s.inInbox(briefText(f.inbox))})` })),
  );
  section(
    s.scheduled,
    scheduled.map((f) => ({ text: `${s.scheduledLine(subj(f.subject), people(f.people), time(Date.parse(f.at)))} (${s.inInbox(briefText(f.inbox))})` })),
  );

  const dashboard = `${opts.appUrl}/dashboard`;
  const settings = `${opts.appUrl}/dashboard/settings`;
  text.push(`${s.openDashboard}: ${dashboard}`, `${s.manage}: ${settings}`, "", s.footer);
  html.push(
    `<p><a href="${escapeHtml(dashboard)}">${escapeHtml(s.openDashboard)}</a><br><a href="${escapeHtml(settings)}">${escapeHtml(s.manage)}</a></p>`,
    `<p><small>${escapeHtml(s.footer)}</small></p>`,
  );

  return { empty, subject: s.subject(dateLabel), text: text.join("\n"), html: html.join("\n"), counts };
}

// ── Rows and updates ───────────────────────────────────────────────────────

export interface MorningBriefRow {
  workspace_id: string;
  enabled: boolean;
  hour: number;
  timezone: string;
  locale: string;
  inbox_id: string | null;
  vip_senders: string[] | null;
  next_due_at: string | null;
  last_local_date: string | null;
  last_sent_at: string | null;
  consecutive_failures: number;
}

export type BriefOutcome = "sent" | "empty" | "not_allowed" | "skipped" | "failed" | "scheduled";

export interface MorningBriefUpdate {
  next_due_at?: string | null;
  last_local_date?: string | null;
  last_sent_at?: string | null;
  last_run_at?: string | null;
  last_outcome?: BriefOutcome | null;
  last_error_code?: string | null;
  consecutive_failures?: number;
  paused_at?: string | null;
}

/** Back-off within the day; pause at the limit (saving the settings again resumes). */
export function briefFailureUpdate(row: Pick<MorningBriefRow, "consecutive_failures">, code: string, nowMs: number): MorningBriefUpdate {
  const failures = (row.consecutive_failures ?? 0) + 1;
  const base = { consecutive_failures: failures, last_error_code: code.slice(0, 64), last_run_at: iso(nowMs), last_outcome: "failed" as const };
  if (failures >= BRIEF_MAX_CONSECUTIVE_FAILURES) return { ...base, paused_at: iso(nowMs), next_due_at: null };
  const backoff = BRIEF_FAILURE_BACKOFF_MS[Math.min(failures, BRIEF_FAILURE_BACKOFF_MS.length) - 1];
  return { ...base, next_due_at: iso(nowMs + backoff) };
}

/** "New since": the last brief, else a day; never more than a week back. */
export function briefSinceMs(row: Pick<MorningBriefRow, "last_sent_at">, nowMs: number): number {
  const last = row.last_sent_at ? Date.parse(row.last_sent_at) : NaN;
  const since = Number.isFinite(last) ? last : nowMs - BRIEF_FIRST_LOOKBACK_MS;
  return Math.max(since, nowMs - BRIEF_MAX_LOOKBACK_MS);
}

// ── The dispatcher ─────────────────────────────────────────────────────────

/** A deliberate skip (configuration, not a fault): no back-off, no pause. */
export class BriefSkip extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface MorningBriefStore {
  releaseStaleLeases(cutoffIso: string): Promise<number>;
  /** Enabled, unpaused, unleased rows with next_due_at NULL or <= now. */
  listDue(nowIso: string, limit: number): Promise<MorningBriefRow[]>;
  /** CAS lease on one row; null when someone else holds it or it changed. */
  claim(workspaceId: string, nowIso: string, token: string): Promise<MorningBriefRow | null>;
  /** Write and drop the lease, only while the lease is still ours. */
  release(workspaceId: string, token: string, update: MorningBriefUpdate): Promise<void>;
}

export interface CollectWindow {
  sinceMs: number;
  nowMs: number;
  /** End of the brief's local day (snoozes and scheduled sends before it). */
  endMs: number;
}

export interface MorningBriefDeps {
  store: MorningBriefStore;
  access(workspaceId: string): Promise<{ allowed: boolean }>;
  /** Read everything the brief shows. Per-inbox failures go in the data, not a throw. */
  collect(row: MorningBriefRow, window: CollectWindow): Promise<BriefData>;
  /** Put the brief into the target inbox. Throw BriefSkip for a configuration problem. */
  deliver(row: MorningBriefRow, brief: BuiltBrief): Promise<void>;
  appUrl: string;
  errorCode(error: unknown): string;
  newToken(): string;
  now?: () => number;
}

export interface BriefDispatchSummary {
  claimed: number;
  sent: number;
  empty: number;
  not_allowed: number;
  skipped: number;
  failed: number;
  scheduled: number;
  busy: number;
  released_stale: number;
  budget_exhausted: boolean;
}

function clock(deps: MorningBriefDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** What to do with a claimed row, before any provider call. Pure. */
export function planBrief(
  row: MorningBriefRow,
  nowMs: number,
): { kind: "wait"; update: MorningBriefUpdate } | { kind: "run"; slot: BriefSlot } {
  const tz = isValidTimeZone(row.timezone) ? row.timezone : "UTC";
  const slot = nextBriefSlot(nowMs, row.hour, tz, row.last_local_date);
  if (slot.slotMs > nowMs) return { kind: "wait", update: { next_due_at: iso(slot.slotMs) } };
  return { kind: "run", slot };
}

/** The row after a finished day (sent, empty, refused or skipped). */
function closeDay(row: MorningBriefRow, slot: BriefSlot, nowMs: number, outcome: BriefOutcome, code: string | null): MorningBriefUpdate {
  const tz = isValidTimeZone(row.timezone) ? row.timezone : "UTC";
  const next = nextBriefSlot(nowMs, row.hour, tz, slot.localDate);
  return {
    last_local_date: slot.localDate,
    last_run_at: iso(nowMs),
    last_outcome: outcome,
    last_error_code: code,
    next_due_at: iso(next.slotMs),
  };
}

export async function runMorningBriefDispatch(deps: MorningBriefDeps): Promise<BriefDispatchSummary> {
  const started = clock(deps);
  const token = deps.newToken();
  const summary: BriefDispatchSummary = {
    claimed: 0,
    sent: 0,
    empty: 0,
    not_allowed: 0,
    skipped: 0,
    failed: 0,
    scheduled: 0,
    busy: 0,
    released_stale: 0,
    budget_exhausted: false,
  };
  try {
    summary.released_stale = await deps.store.releaseStaleLeases(iso(started - BRIEF_STALE_LEASE_MS));
  } catch (error) {
    console.warn("[morning-brief] stale lease release failed", deps.errorCode(error));
  }

  const due = await deps.store.listDue(iso(started), BRIEF_DUE_SCAN_LIMIT);
  for (const candidate of due) {
    if (summary.claimed >= MAX_BRIEFS_PER_INVOCATION) break;
    if (clock(deps) - started >= BRIEF_TIME_BUDGET_MS) {
      summary.budget_exhausted = true;
      break;
    }
    let row: MorningBriefRow | null;
    try {
      row = await deps.store.claim(candidate.workspace_id, iso(clock(deps)), token);
    } catch {
      continue;
    }
    if (!row) {
      summary.busy++;
      continue;
    }
    summary.claimed++;
    const update = await processRow(deps, row, summary);
    await deps.store.release(row.workspace_id, token, update).catch((error) => {
      console.error("[morning-brief] release failed", { workspace_id: row!.workspace_id, error: deps.errorCode(error) });
    });
  }
  return summary;
}

async function processRow(deps: MorningBriefDeps, row: MorningBriefRow, summary: BriefDispatchSummary): Promise<MorningBriefUpdate> {
  const nowMs = clock(deps);
  const plan = planBrief(row, nowMs);
  if (plan.kind === "wait") {
    summary.scheduled++;
    return plan.update;
  }
  const { slot } = plan;

  let allowed = false;
  try {
    allowed = (await deps.access(row.workspace_id)).allowed === true;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    // Left Pro, or the rollout is off: no brief, nothing read. Checked again tomorrow.
    summary.not_allowed++;
    return closeDay(row, slot, nowMs, "not_allowed", null);
  }
  if (!row.inbox_id) {
    summary.skipped++;
    return closeDay(row, slot, nowMs, "skipped", "target_inbox_missing");
  }

  const tz = isValidTimeZone(row.timezone) ? row.timezone : "UTC";
  const sinceMs = briefSinceMs(row, nowMs);
  try {
    const data = await deps.collect(row, { sinceMs, nowMs, endMs: endOfLocalDay(slot.localDate, tz) });
    const brief = buildBrief(data, {
      locale: isBriefLocale(row.locale) ? row.locale : "en",
      timezone: tz,
      localDate: slot.localDate,
      sinceMs,
      vips: normalizeVipList(row.vip_senders ?? []),
      appUrl: deps.appUrl,
    });
    const done = clock(deps);
    if (brief.empty) {
      summary.empty++;
      return { ...closeDay(row, slot, done, "empty", null), consecutive_failures: 0 };
    }
    await deps.deliver(row, brief);
    summary.sent++;
    return { ...closeDay(row, slot, done, "sent", null), last_sent_at: iso(done), consecutive_failures: 0 };
  } catch (error) {
    if (error instanceof BriefSkip) {
      summary.skipped++;
      return closeDay(row, slot, clock(deps), "skipped", error.code);
    }
    const update = briefFailureUpdate(row, deps.errorCode(error), clock(deps));
    summary.failed++;
    return update;
  }
}
