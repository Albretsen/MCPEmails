'use client';

import { createContext, useContext, useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { routing } from '@/i18n/routing';
import { peekAppCatalog, loadAppCatalog } from './app-locale-catalogs.mjs';

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
 * The catalogs live in app-locale-catalogs.mjs. English is bundled; the other
 * four languages are fetched on demand, so there are two notions of "the
 * language" in here and they are deliberately separate:
 *
 *   - `locale`  is the person's CHOICE. It changes the instant they choose,
 *               it is what `useAppLocale()` returns and what is persisted.
 *   - `shown`   is the language actually ON SCREEN, and it only ever names a
 *               catalog that has finished loading. Until the chosen one is
 *               ready the screen keeps the language it had (English on a first
 *               load), so there is never a frame of missing strings.
 */
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

// Start fetching the person's language as soon as this module runs in the
// browser, which is before React hydrates. It changes nothing that is rendered
// (the first render is English regardless); it only means the catalog is
// usually already here by the time the mount effect below asks for it, so a
// non-English user leaves English about as early as when it was bundled.
if (typeof window !== 'undefined') {
  const preferred = readStored() ?? detectBrowserLocale();
  if (!peekAppCatalog(preferred)) loadAppCatalog(preferred).catch(() => {});
}

export default function AppLocaleProvider({ children }) {
  // Begin at the default locale so the first paint matches the server render,
  // then resolve the real preference (stored choice, else browser language).
  const [locale, setLocaleState] = useState(routing.defaultLocale);
  // The language on screen. See the note at the top: it follows `locale` as
  // soon as that language's catalog is available.
  const [shown, setShown] = useState(routing.defaultLocale);
  // The most recent choice, readable from inside a load that finishes later.
  const latest = useRef(routing.defaultLocale);

  const choose = useCallback((next) => {
    latest.current = next;
    setLocaleState(next);
    if (peekAppCatalog(next)) {
      // Already here (always true for English): one render, as before.
      setShown(next);
      return;
    }
    loadAppCatalog(next).then(
      () => {
        // Only the LAST choice may change the screen. A slower load for an
        // earlier choice finishes into the cache and is otherwise ignored.
        if (latest.current === next) setShown(next);
      },
      () => {
        // Offline, or the chunk is gone after a deploy. Fall back to English,
        // which is always bundled, rather than leave the screen in whatever
        // language it happened to be in. The choice itself stays stored, so
        // the next visit (or choosing it again) retries.
        if (latest.current === next) setShown(routing.defaultLocale);
      },
    );
  }, []);

  useEffect(() => {
    // Resolves the real locale after the first paint, which had to match the server's default
    // locale.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    choose(readStored() ?? detectBrowserLocale());
  }, [choose]);

  useEffect(() => {
    try {
      document.documentElement.lang = shown;
    } catch {
      /* no-op */
    }
  }, [shown]);

  const setLocale = useCallback((next) => {
    if (!isSupported(next)) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* no-op */
    }
    choose(next);
  }, [choose]);

  const ctx = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <AppLocaleContext.Provider value={ctx}>
      <NextIntlClientProvider locale={shown} messages={peekAppCatalog(shown)}>
        {children}
      </NextIntlClientProvider>
    </AppLocaleContext.Provider>
  );
}
