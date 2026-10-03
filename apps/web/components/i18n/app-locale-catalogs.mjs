// ---------------------------------------------------------------------------
// The message catalogs AppLocaleProvider renders from.
//
// English is imported statically: it is what the server renders and what the
// first client render must match, so it has to be there before anything runs.
// Every other language is behind an `import()` and is fetched only for the
// person who uses it. All five used to be static imports, which put about
// 410 KB of JSON (five languages of four namespaces) in front of every visitor
// to the dashboard and every auth screen, four fifths of it never read.
//
// THE IMPORT PATHS ARE WRITTEN OUT, one line per file, on purpose. A bundler
// only splits an `import()` whose path it can read; a path built from a
// variable (`messages/${locale}/...`) makes it bundle the whole directory.
// Adding a language means adding a block here and a locale in i18n/routing.
//
// A catalog that has loaded is kept for the life of the page, and it is the
// same object every time, so switching back to a language is instant and
// next-intl sees a stable `messages` identity. A load that fails is forgotten,
// so the next attempt really does try again.
// ---------------------------------------------------------------------------

import enDashboard from '../../messages/en/dashboard.json';
import enDashboardChrome from '../../messages/en/dashboardChrome.json';
import enAuth from '../../messages/en/auth.json';
import enCommon from '../../messages/en/common.json';

const ENGLISH = { dashboard: enDashboard, dashboardChrome: enDashboardChrome, auth: enAuth, common: enCommon };

/** Each returns the four namespace modules, in the order `assemble` expects. */
const LOADERS = {
  nb: () => Promise.all([
    import('../../messages/nb/dashboard.json'),
    import('../../messages/nb/dashboardChrome.json'),
    import('../../messages/nb/auth.json'),
    import('../../messages/nb/common.json'),
  ]),
  es: () => Promise.all([
    import('../../messages/es/dashboard.json'),
    import('../../messages/es/dashboardChrome.json'),
    import('../../messages/es/auth.json'),
    import('../../messages/es/common.json'),
  ]),
  fr: () => Promise.all([
    import('../../messages/fr/dashboard.json'),
    import('../../messages/fr/dashboardChrome.json'),
    import('../../messages/fr/auth.json'),
    import('../../messages/fr/common.json'),
  ]),
  zh: () => Promise.all([
    import('../../messages/zh/dashboard.json'),
    import('../../messages/zh/dashboardChrome.json'),
    import('../../messages/zh/auth.json'),
    import('../../messages/zh/common.json'),
  ]),
};

function assemble([dashboard, dashboardChrome, auth, common]) {
  return {
    dashboard: dashboard.default,
    dashboardChrome: dashboardChrome.default,
    auth: auth.default,
    common: common.default,
  };
}

const ready = new Map([['en', ENGLISH]]);
const pending = new Map();

/** The catalog for `locale` if it is already here, else null. Never loads. */
export function peekAppCatalog(locale) {
  return ready.get(locale) ?? null;
}

/**
 * Resolves with the catalog for `locale`, fetching it if needed. Concurrent
 * calls share one fetch. Rejects for a language with no catalog and when the
 * fetch fails; a failure is not cached.
 */
export function loadAppCatalog(locale) {
  const have = ready.get(locale);
  if (have) return Promise.resolve(have);
  const inFlight = pending.get(locale);
  if (inFlight) return inFlight;
  const loader = Object.hasOwn(LOADERS, locale) ? LOADERS[locale] : null;
  if (!loader) return Promise.reject(new Error(`No message catalog for locale "${locale}"`));
  const load = loader().then(
    (modules) => {
      const catalog = assemble(modules);
      ready.set(locale, catalog);
      pending.delete(locale);
      return catalog;
    },
    (err) => {
      pending.delete(locale);
      throw err;
    },
  );
  pending.set(locale, load);
  return load;
}
