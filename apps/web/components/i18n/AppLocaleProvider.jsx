'use client';

import { LocaleRoot, prefetchPreferredLocale, preferredAppLocale, useAppLocale } from './LocaleCore';

import enDashboard from '../../messages/en/dashboard.json';
import enDashboardChrome from '../../messages/en/dashboardChrome.json';
import enAuth from '../../messages/en/auth.json';
import enCommon from '../../messages/en/common.json';
import enConvert from '../../messages/en/convert.json';

/**
 * Client-side locale provider for the authenticated app and auth screens.
 *
 * These routes are NOT localized by URL (no /nb prefix). The active language
 * comes from the user's stored choice (localStorage 'mcpe-locale'), falling
 * back to the browser language, then the default locale. This is independent
 * of the URL-based locale used by the public marketing pages.
 *
 * It carries its own message namespaces (dashboard, auth, ...) and overrides
 * the root NextIntlClientProvider for its subtree.
 *
 * THE READING LANGUAGE. Signup and login links on a translated marketing page
 * say which language it was in (`/signup?lang=fr`, see
 * src/i18n/reading-lang.mjs). The /signup and /login layouts pass
 * `readLangParam`, and a valid `lang` then wins over the stored choice and the
 * browser. It is used for the server render too (so the form is in that
 * language from the first paint, with nothing to hydrate differently), and is
 * stored under the same key the Settings picker writes, so the dashboard after
 * the Google or GitHub round trip opens in it as well. A later choice in
 * Settings overwrites it like any other. `initialLocale` is the same thing
 * handed in directly. An invalid value is ignored.
 *
 * /login sits under the (auth) layout's provider too. Child effects run before
 * parent ones, so the inner provider has stored the language by the time the
 * outer one reads storage, and both end on it.
 */
const NAMESPACES = ['dashboard', 'dashboardChrome', 'auth', 'common', 'convert'];

/**
 * English is bundled: it is the server render, the hydration render and the
 * fallback. Every other language is fetched on demand (see LocaleCore.jsx).
 * Auth screens use AuthLocaleProvider instead, which leaves out the two
 * dashboard namespaces.
 */
const ENGLISH = { dashboard: enDashboard, dashboardChrome: enDashboardChrome, auth: enAuth, common: enCommon, convert: enConvert };

prefetchPreferredLocale(NAMESPACES, ENGLISH);

export { preferredAppLocale, useAppLocale };

export default function AppLocaleProvider({ children, initialLocale = null, readLangParam = false }) {
  return (
    <LocaleRoot initialLocale={initialLocale} readLangParam={readLangParam} namespaces={NAMESPACES} english={ENGLISH}>
      {children}
    </LocaleRoot>
  );
}
