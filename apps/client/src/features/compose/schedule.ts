/* Schedule-send presets with real dates. */

export interface ScheduleOption {
  label: string;
  /** Short form for the menu: "Thu 8:00 AM", "Today 2:00 PM". */
  when: string;
  /** Long form for the toast: "Thu, Oct 1, 8:00 AM". */
  full: string;
  at: Date;
}

export const MORNING_HOUR = 8;
export const AFTERNOON_HOUR = 14;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function atHour(day: Date, hour: number): Date {
  const d = new Date(day);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Thu 8:00 AM" / "Today 2:00 PM" and the long form, relative to `now`. */
export function describeSchedule(at: Date, now: Date = new Date()): { when: string; full: string } {
  if (sameDay(at, now)) {
    const t = timeFmt.format(at);
    return { when: `Today ${t}`, full: `Today, ${t}` };
  }
  return { when: dayTimeFmt.format(at), full: fullFmt.format(at) };
}

/** Tomorrow 8:00, next Monday 8:00 (unless that IS tomorrow), and today 14:00
 *  while it is still ahead. All in the user's local time. */
export function scheduleOptions(now: Date = new Date()): ScheduleOption[] {
  const out: { label: string; at: Date }[] = [];

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  out.push({ label: "Tomorrow morning", at: atHour(tomorrow, MORNING_HOUR) });

  // The next Monday strictly after today (getDay: 0 = Sunday, 1 = Monday).
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  if (!sameDay(monday, tomorrow)) out.push({ label: "Monday morning", at: atHour(monday, MORNING_HOUR) });

  const afternoon = atHour(now, AFTERNOON_HOUR);
  if (afternoon.getTime() > now.getTime()) out.push({ label: "This afternoon", at: afternoon });

  return out.map((o) => ({ ...o, ...describeSchedule(o.at, now) }));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A Date as the value of <input type="datetime-local"> (local time, minutes). */
export function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses a datetime-local value as LOCAL time. Null when it is not a date or
 *  not at least a minute in the future. */
export function parseLocalInputValue(value: string, now: Date = new Date()): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  if (Number.isNaN(d.getTime()) || d.getTime() < now.getTime() + 60_000) return null;
  return d;
}

/** Default for the custom picker: a full hour, one to two hours away. */
export function defaultCustomTime(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(d.getHours() + 2, 0, 0, 0);
  return d;
}
