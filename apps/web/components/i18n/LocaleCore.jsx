'use client';

import { createContext, useContext, useEffect, useState, useMemo, useCallback, useRef, use } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { LANG_PARAM, readingLangFromParam } from '@/i18n/reading-lang.mjs';
import { withEnglishFallback } from '@/i18n/locale-policy.mjs';

/**
 * The machinery behind AppLocaleProvider (dashboard, all four namespaces) and
 * AuthLocaleProvider (sign-up, login, consent: auth + common only). See
 * AppLocaleProvider.jsx for how the language is chosen.
 *
 * WHY THE CATALOGS ARE LOADED ON DEMAND. Importing every language statically
 * put all six catalogs (~477 KB raw, ~146 KB gzipped) into the first-load JS of
 * /signup, /login, /authorize and the dashboard, while a visitor only ever
 * reads one. English is still imported statically by the two wrappers (it is
 * the server render and the hydration render, and the fallback); every other
 * language is one `import()` per namespace, fetched when it is needed.
 *
 * NO KEY PATHS, NO MISMATCH. A language is never shown before its catalog has
 * arrived: until then the screen stays on what it showed before (English, or
 * the previous language). The language the context reports (`locale`, what the
 * Settings picker marks) moves at once; the messages follow when loaded. A
 * reading language (`initialLocale`, `?lang=`) is rendered from the server
 * render on: the render waits for its catalog with React's `use()`, on the
 * server and during hydration alike, so both produce the same markup.
 */

/** Every non-English catalog, one chunk per file. Literal paths, so the bundler splits exactly these. */
const LOADERS = {
  nb: {
    dashboard: () => import('../../messages/nb/dashboard.json'),
    dashboardChrome: () => import('../../messages/nb/dashboardChrome.json'),
    auth: () => import('../../messages/nb/auth.json'),
    common: () => import('../../messages/nb/common.json'),
  },
  es: {
    dashboard: () => import('../../messages/es/dashboard.json'),
    dashboardChrome: () => import('../../messages/es/dashboardChrome.json'),
    auth: () => import('../../messages/es/auth.json'),
    common: () => import('../../messages/es/common.json'),
  },
  fr: {
    dashboard: () => import('../../messages/fr/dashboard.json'),
    dashboardChrome: () => import('../../messages/fr/dashboardChrome.json'),
    auth: () => import('../../messages/fr/auth.json'),
    common: () => import('../../messages/fr/common.json'),
  },
  zh: {
    dashboard: () => import('../../messages/zh/dashboard.json'),
    dashboardChrome: () => import('../../messages/zh/dashboardChrome.json'),
    auth: () => import('../../messages/zh/auth.json'),
    common: () => import('../../messages/zh/common.json'),
  },
  de: {
    dashboard: () => import('../../messages/de/dashboard.json'),
    dashboardChrome: () => import('../../messages/de/dashboardChrome.json'),
    auth: () => import('../../messages/de/auth.json'),
    common: () => import('../../messages/de/common.json'),
  },
};

/** `${locale}/${namespace}` -> the loaded catalog file. */
const LOADED = new Map();
/** `${locale}/${namespace}` -> the in-flight load. */
const LOADING = new Map();
/** `${locale}|${namespaces}` -> the effective messages, so their identity is stable. */
const EFFECTIVE = new Map();
/** `${locale}|${namespaces}` -> a promise of the effective messages (null on failure), for `use()`. */
const PROMISES = new Map();

function loadNamespace(locale, ns) {
  const key = `${locale}/${ns}`;
  if (LOADED.has(key)) return Promise.resolve(LOADED.get(key));
  if (!LOADING.has(key)) {
    const promise = LOADERS[locale][ns]().then(
      (mod) => {
        const json = mod && mod.default !== undefined ? mod.default : mod;
        LOADED.set(key, json);
        LOADING.delete(key);
        return json;
      },
      (err) => {
        LOADING.delete(key); // A later request may try again.
        throw err;
      },
    );
    LOADING.set(key, promise);
  }
  return LOADING.get(key);
}

/**
 * What `locale` renders for these namespaces, or null while a file is still
 * missing. A frozen locale (zh) is laid over English (src/i18n/locale-policy.mjs).
 */
function readyMessages(locale, namespaces, english) {
  if (locale === routing.defaultLocale) return english;
  const id = `${locale}|${namespaces.join(',')}`;
  if (EFFECTIVE.has(id)) return EFFECTIVE.get(id);
  if (!namespaces.every((ns) => LOADED.has(`${locale}/${ns}`))) return null;
  const raw = Object.fromEntries(namespaces.map((ns) => [ns, LOADED.get(`${locale}/${ns}`)]));
  const effective = withEnglishFallback(locale, raw, english);
  EFFECTIVE.set(id, effective);
  return effective;
}

/** Resolves to the effective messages once loaded, or null if a file failed to load. Never rejects. */
function messagesPromise(locale, namespaces, english) {
  const id = `${locale}|${namespaces.join(',')}`;
  if (!PROMISES.has(id)) {
    const promise = Promise.all(namespaces.map((ns) => loadNamespace(locale, ns))).then(
      () => readyMessages(locale, namespaces, english),
      () => {
        PROMISES.delete(id);
        return null;
      },
    );
    PROMISES.set(id, promise);
  }
  return PROMISES.get(id);
}

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

const STORAGE_KEY = 'mcpe-locale';

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isSupported(v)) return v;
  } catch {
    /* localStorage unavailable */
  }
  return null;
}

/**
 * Starts fetching the visitor's preferred language as soon as a wrapper module
 * runs in the browser, so it is usually there by the time the provider's
 * effect asks for it. Server: no-op.
 */
export function prefetchPreferredLocale(namespaces, english) {
  if (typeof window === 'undefined') return;
  const preferred = readStored() ?? detectBrowserLocale();
  if (preferred !== routing.defaultLocale) messagesPromise(preferred, namespaces, english);
}

const AppLocaleContext = createContext({
  locale: routing.defaultLocale,
  setLocale: () => {},
});

/** Read or change the app-realm language (persisted to localStorage). */
export function useAppLocale() {
  return useContext(AppLocaleContext);
}

export function LocaleRoot({ children, initialLocale = null, readLangParam = false, namespaces, english }) {
  // A layout's choice, fixed for its life, so this is never a conditional hook.
  return readLangParam
    ? <LangParamLocaleProvider namespaces={namespaces} english={english}>{children}</LangParamLocaleProvider>
    : <LocaleProvider initialLocale={initialLocale} namespaces={namespaces} english={english}>{children}</LocaleProvider>;
}

/**
 * Reads `?lang=` (src/i18n/reading-lang.mjs) during render, so the server
 * render of the page (both are dynamic) already has it. Only the /signup and
 * /login layouts use it, the two pages marketing links point at: a `lang` left
 * on any other app URL must not be able to override a choice made in Settings.
 */
function LangParamLocaleProvider({ children, namespaces, english }) {
  const params = useSearchParams();
  const fromUrl = readingLangFromParam(params?.get(LANG_PARAM) ?? null);
  return <LocaleProvider initialLocale={fromUrl} namespaces={namespaces} english={english}>{children}</LocaleProvider>;
}

function LocaleProvider({ children, initialLocale, namespaces, english }) {
  const fromPage = isSupported(initialLocale) ? initialLocale : null;
  // `locale` is the language asked for (what the picker marks); `shown` is the
  // one on screen, which only moves once its catalog is loaded. Both begin at
  // the page's language when it named one (the server rendered that too), else
  // at the default locale so the first paint matches the server render; the
  // real preference (stored choice, else browser language) is resolved after.
  const [locale, setLocaleState] = useState(fromPage ?? routing.defaultLocale);
  const [shown, setShown] = useState(fromPage ?? routing.defaultLocale);
  const latest = useRef(null);

  // Only a reading language can be shown before its catalog is in memory (the
  // first render, on the server or hydrating): wait for it here.
  let messages = readyMessages(shown, namespaces, english);
  if (!messages) messages = use(messagesPromise(shown, namespaces, english));
  // A catalog that failed to load: English rather than key paths.
  const shownLocale = messages ? shown : routing.defaultLocale;
  if (!messages) messages = english;

  const request = useCallback((next) => {
    latest.current = next;
    setLocaleState(next);
    if (readyMessages(next, namespaces, english)) {
      setShown(next);
      return;
    }
    messagesPromise(next, namespaces, english).then((loaded) => {
      // A later selection wins over a slower, earlier one.
      if (loaded && latest.current === next) setShown(next);
    });
  }, [namespaces, english]);

  useEffect(() => {
    if (fromPage) {
      try {
        localStorage.setItem(STORAGE_KEY, fromPage);
      } catch {
        /* localStorage unavailable */
      }
      return;
    }
    // Resolves the real locale after the first paint, which had to match the
    // server's default locale.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    request(readStored() ?? detectBrowserLocale());
  }, [fromPage, request]);

  useEffect(() => {
    try {
      document.documentElement.lang = shownLocale;
    } catch {
      /* no-op */
    }
  }, [shownLocale]);

  const setLocale = useCallback((next) => {
    if (!isSupported(next)) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* no-op */
    }
    request(next);
  }, [request]);

  const ctx = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <AppLocaleContext.Provider value={ctx}>
      <NextIntlClientProvider locale={shownLocale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </AppLocaleContext.Provider>
  );
}
