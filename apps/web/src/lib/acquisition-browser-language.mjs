/**
 * The main language of a browser, as a short code, for the Arabic guide test.
 *
 * Only the primary subtag of the first entry in Accept-Language is kept ('ar'
 * from 'ar-SA,ar;q=0.9,en;q=0.8'). Region and the rest of the list are dropped.
 * A missing, wildcard or malformed value is unknown.
 */
export const ARABIC_GUIDE_PATH = '/docs/claude-email-arabic';

export function primaryLanguageFromHeader(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0].split(';')[0].trim().toLowerCase();
  const primary = first.split('-')[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}
