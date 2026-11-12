/**
 * The masthead date: today in Oslo, worked out per request (the home page is
 * rendered dynamically on staging, the lab reads a cookie), so the edition
 * date turns over at midnight Oslo time, not UTC.
 */
export function osloToday(now = new Date()) {
  const label = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  // en-CA formats as YYYY-MM-DD, which is what <time dateTime> wants.
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return { label, iso };
}

/** A changelog date (YYYY-MM-DD) as "11 Nov 2026", no time zone shift. */
export function shortDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${month} ${y}`;
}
