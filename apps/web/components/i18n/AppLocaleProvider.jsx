'use client';

import { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { routing } from '@/i18n/routing';

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
 */
const MESSAGES = {
  en: { dashboard: enDashboard, dashboardChrome: enDashboardChrome, auth: enAuth, common: enCommon },
  nb: { dashboard: nbDashboard, dashboardChrome: nbDashboardChrome, auth: nbAuth, common: nbCommon },
  es: { dashboard: esDashboard, dashboardChrome: esDashboardChrome, auth: esAuth, common: esCommon },
  fr: { dashboard: frDashboard, dashboardChrome: frDashboardChrome, auth: frAuth, common: frCommon },
  zh: { dashboard: zhDashboard, dashboardChrome: zhDashboardChrome, auth: zhAuth, common: zhCommon },
};

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

export default function AppLocaleProvider({ children }) {
  // Begin at the default locale so the first paint matches the server render,
  // then resolve the real preference (stored choice, else browser language).
  const [locale, setLocaleState] = useState(routing.defaultLocale);

  useEffect(() => {
    setLocaleState(readStored() ?? detectBrowserLocale());
  }, []);

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
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        {children}
      </NextIntlClientProvider>
    </AppLocaleContext.Provider>
  );
}
