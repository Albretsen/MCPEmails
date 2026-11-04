// Single source of truth for legal page dates.
// Update here when policies change; the pages pick up the new values automatically.
// LAST_UPDATED is the Terms page's date. The Privacy Policy has its own since
// 2026-09-29 (the marketing-email consent purpose), because bumping one
// document's date must not claim the other changed too.
export const LAST_UPDATED = 'November 1, 2026';
export const PRIVACY_LAST_UPDATED = 'November 1, 2026';
export const EFFECTIVE_DATE = 'May 25, 2026';

// The constants above are English prose dates. Pages render them in the
// reader's locale (e.g. "1 de novembro de 2026", "2026年11月1日").
export function formatLegalDate(value, locale) {
  const d = new Date(`${value} 12:00 UTC`);
  if (Number.isNaN(d.getTime())) return value;
  const tag = locale === 'pt' ? 'pt-BR' : locale === 'zh' ? 'zh-CN' : locale;
  return new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}
