/* Date and text formatting. All inputs are ISO UTC strings from the wire. */

const DAY = 86_400_000;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const yearFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** List column: "9:41" today, "Tue" this week, "Sep 28" this year, "Sep 28, 2025" before. */
export function formatListTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (days === 0) return timeFmt.format(t);
  // A later day (a scheduled send): the time alone would read as today.
  if (days < 0) return days > -7 ? `${weekdayFmt.format(t)} ${timeFmt.format(t)}` : monthDayFmt.format(t);
  if (days < 7) return weekdayFmt.format(t);
  if (new Date(t).getFullYear() === new Date(now).getFullYear()) return monthDayFmt.format(t);
  return yearFmt.format(t);
}

/** Reader header: "Today 9:41", "Tue, Sep 29", "Sep 28, 2025". */
export function formatFullTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (days === 0) return `Today ${timeFmt.format(t)}`;
  if (days === 1) return `Yesterday ${timeFmt.format(t)}`;
  if (days === -1) return `Tomorrow ${timeFmt.format(t)}`;
  if (new Date(t).getFullYear() === new Date(now).getFullYear()) return `${fullDayFmt.format(t)}, ${timeFmt.format(t)}`;
  return yearFmt.format(t);
}

/** "MC" for "Maya Chen", "S" for "Stripe", "?" for nothing. */
export function initials(name: string, fallbackEmail = ""): string {
  const src = name.trim() || fallbackEmail.trim();
  if (!src) return "?";
  return src
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Display name for an address entry: the name, else the address. */
export function displayName(a: { name: string; email: string }): string {
  return a.name.trim() || a.email;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
