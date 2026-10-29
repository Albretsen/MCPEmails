import { routing } from '@/i18n/routing';

const LOCALES: readonly string[] = routing.locales;

/** The locale a referral visitor lands in; see app/r/[code]/route.ts. */
export function referralLandingLocale(request: Request): string {
  const explicit = new URL(request.url).searchParams.get('lang')?.toLowerCase();
  if (explicit && LOCALES.includes(explicit)) return explicit;
  const header = request.headers.get('accept-language') ?? '';
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split('-')[0], weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.lang && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  // Norwegian Bokmal is served as nb; "no" is how many browsers send it.
  for (const { lang } of ranked) {
    const locale = lang === 'no' ? 'nb' : lang;
    if (LOCALES.includes(locale)) return locale;
  }
  return routing.defaultLocale;
}

export function referralHomePath(locale: string): string {
  return locale === routing.defaultLocale ? '/' : `/${locale}`;
}

