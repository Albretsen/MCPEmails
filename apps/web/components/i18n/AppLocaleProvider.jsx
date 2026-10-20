'use client';

import { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { LANG_PARAM, readingLangFromParam } from '@/i18n/reading-lang.mjs';
import { withEnglishFallback } from '@/i18n/locale-policy.mjs';

import enDashboard from '../../messages/en/dashboard.json';
import enDashboardChrome from '../../messages/en/dashboardChrome.json';
import enAuth from '../../messages/en/auth.json';
import enCommon from '../../messages/en/common.json';
import nbDashboard from '../../messages/nb/dashboard.json';
import nbDashboardChrome from '../../messages/nb/dashboardChrome.json';
import nbAuth from '../../messages/nb/auth.json';
import nbCommon from '../../messages/nb/common.json';
import esDashboard from '../../messages/es/dashboard.json';
import esDashboardChrome from '../../messages/es/dashboardChrome.json';
import esAuth from '../../messages/es/auth.json';
import esCommon from '../../messages/es/common.json';
import frDashboard from '../../messages/fr/dashboard.json';
import frDashboardChrome from '../../messages/fr/dashboardChrome.json';
import frAuth from '../../messages/fr/auth.json';
import frCommon from '../../messages/fr/common.json';
import zhDashboard from '../../messages/zh/dashboard.json';
import zhDashboardChrome from '../../messages/zh/dashboardChrome.json';
import zhAuth from '../../messages/zh/auth.json';
import zhCommon from '../../messages/zh/common.json';
import deDashboard from '../../messages/de/dashboard.json';
import deDashboardChrome from '../../messages/de/dashboardChrome.json';
import deAuth from '../../messages/de/auth.json';
import deCommon from '../../messages/de/common.json';

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
const MESSAGES = {
  en: { dashboard: enDashboard, dashboardChrome: enDashboardChrome, auth: enAuth, common: enCommon },
  nb: { dashboard: nbDashboard, dashboardChrome: nbDashboardChrome, auth: nbAuth, common: nbCommon },
  es: { dashboard: esDashboard, dashboardChrome: esDashboardChrome, auth: esAuth, common: esCommon },
  fr: { dashboard: frDashboard, dashboardChrome: frDashboardChrome, auth: frAuth, common: frCommon },
  zh: { dashboard: zhDashboard, dashboardChrome: zhDashboardChrome, auth: zhAuth, common: zhCommon },
  de: { dashboard: deDashboard, dashboardChrome: deDashboardChrome, auth: deAuth, common: deCommon },
};

/**
 * What each language actually renders: a frozen locale (zh, see
 * src/i18n/locale-policy.mjs) is laid over English, so a key added after the
 * freeze shows the English string rather than a raw key path. Computed once at
 * module load; full locales are passed through untouched.
 */
const EFFECTIVE_MESSAGES = Object.fromEntries(
  Object.entries(MESSAGES).map(([code, messages]) => [
    code,
    withEnglishFallback(code, messages, MESSAGES.en),
  ]),
);

const STORAGE_KEY = 'mcpe-locale';

function isSupported(value) {
  return typeof value === 'string' && routing.locales.includes(value);
}

function detectBrowserLocale() {
  if (typeof navigator === 'undefined') return routing.defaultLocale;
  const langs =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
  for (const raw of langs) {
    const low = (raw || '').toLowerCase();
    if (low.startsWith('nb') || low.startsWith('no') || low.startsWith('nn')) return 'nb';
    if (low.startsWith('es')) return 'es';
    if (low.startsWith('fr')) return 'fr';
    if (low.startsWith('zh')) return 'zh';
    if (low.startsWith('de')) return 'de';
    if (low.startsWith('en')) return 'en';
  }
  return routing.defaultLocale;
}

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isSupported(v)) return v;
  } catch {
    /* localStorage unavailable */
  }
  return null;
}

const AppLocaleContext = createContext({
  locale: routing.defaultLocale,
  setLocale: () => {},
});

/** Read or change the app-realm language (persisted to localStorage). */
export function useAppLocale() {
  return useContext(AppLocaleContext);
}

export default function AppLocaleProvider({ children, initialLocale = null, readLangParam = false }) {
  // A layout's choice, fixed for its life, so this is never a conditional hook.
  return readLangParam
    ? <LangParamLocaleProvider>{children}</LangParamLocaleProvider>
    : <LocaleProvider initialLocale={initialLocale}>{children}</LocaleProvider>;
}

/**
 * Reads `?lang=` (src/i18n/reading-lang.mjs) during render, so the server
 * render of the page (both are dynamic) already has it. Only the /signup and
 * /login layouts use it, the two pages marketing links point at: a `lang` left
 * on any other app URL must not be able to override a choice made in Settings.
 */
function LangParamLocaleProvider({ children }) {
  const params = useSearchParams();
  const fromUrl = readingLangFromParam(params?.get(LANG_PARAM) ?? null);
  return <LocaleProvider initialLocale={fromUrl}>{children}</LocaleProvider>;
}

function LocaleProvider({ children, initialLocale }) {
  const fromPage = isSupported(initialLocale) ? initialLocale : null;
  // Begin at the page's language when it named one (the server rendered that
  // too), else at the default locale so the first paint matches the server
  // render, then resolve the real preference (stored choice, else browser
  // language).
  const [locale, setLocaleState] = useState(fromPage ?? routing.defaultLocale);

  useEffect(() => {
    if (fromPage) {
      try {
        localStorage.setItem(STORAGE_KEY, fromPage);
      } catch {
        /* localStorage unavailable */
      }
      return;
    }
    // Resolves the real locale after the first paint, which had to match the server's default
    // locale.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocaleState(readStored() ?? detectBrowserLocale());
  }, [fromPage]);

  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      /* no-op */
    }
  }, [locale]);

  const setLocale = useCallback((next) => {
    if (!isSupported(next)) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* no-op */
    }
    setLocaleState(next);
  }, []);

  const ctx = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <AppLocaleContext.Provider value={ctx}>
      <NextIntlClientProvider locale={locale} messages={EFFECTIVE_MESSAGES[locale]}>
        {children}
      </NextIntlClientProvider>
    </AppLocaleContext.Provider>
  );
}
