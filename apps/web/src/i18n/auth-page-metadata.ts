import { LANG_PARAM, readingLangFromParam } from './reading-lang.mjs';
import enAuth from '../../messages/en/auth.json';

type AuthScreen = 'signup' | 'login';

type AuthCatalog = Record<AuthScreen, { title: string; metaDescription: string }>;

/**
 * `<title>` and description for /signup and /login in the language the visitor
 * was reading.
 *
 * Both pages sit outside app/[locale], so their metadata used to be a fixed
 * English string: a visitor who pressed "Konto erstellen" on /de/pricing got a
 * German form under a tab that said "Create your account". The marketing links
 * carry the language as `?lang=` (src/i18n/reading-lang.mjs), the same
 * parameter the form reads, so the server render can pick the title from the
 * same `auth` catalog the form renders from. A visitor without the parameter
 * (a stored choice, or the browser language) is handled in the browser by
 * useDocumentTitle, once the form knows which language it shows.
 */
export async function authPageMetadata(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  screen: AuthScreen,
): Promise<{ title: string; description: string }> {
  const raw = searchParams?.[LANG_PARAM];
  const lang = readingLangFromParam(typeof raw === 'string' ? raw : null);
  let catalog: AuthCatalog = enAuth as unknown as AuthCatalog;
  if (lang && lang !== 'en') {
    try {
      const mod = await import(`../../messages/${lang}/auth.json`);
      catalog = (mod.default ?? mod) as AuthCatalog;
    } catch {
      // A catalog that fails to load leaves the English title, never an error page.
    }
  }
  const entry = catalog[screen] ?? (enAuth as unknown as AuthCatalog)[screen];
  return {
    title: entry.title,
    description: entry.metaDescription ?? (enAuth as unknown as AuthCatalog)[screen].metaDescription,
  };
}
