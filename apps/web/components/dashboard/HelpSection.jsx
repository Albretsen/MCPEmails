'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import HelpCenter from '../support/HelpCenter';
import { pathSegmentToSection } from './routes';

/**
 * The dashboard's help section (/dashboard/help): the same help center as
 * /help, inside the app shell.
 *
 * SUPPORT_RELEASE_GATE: App renders this only when `supportVisible`, and the
 * data route answers 404 to anyone the gate hides.
 *
 * Its data comes from GET /api/support/help-data, in the app's own locale
 * (which lives in the browser, not the URL). `topic`, `provider`, `code` and
 * `from` in the page URL are passed along so the connect modal's "Contact
 * support" link arrives with the form already filled in.
 *
 * `onNavigateSection(section)` switches dashboard sections for article links
 * that point at /dashboard/<section>, so they do not reload the app.
 */

const FORWARDED = ['topic', 'provider', 'code', 'from'];

export function helpDataUrl(locale, search) {
  const page = new URLSearchParams(search ?? '');
  const q = new URLSearchParams({ locale: locale || 'en' });
  for (const k of FORWARDED) {
    const v = page.get(k);
    if (v) q.set(k, v);
  }
  return `/api/support/help-data?${q.toString()}`;
}

/** The dashboard section a link points at, or null for anything else. */
export function dashboardSectionFor(href) {
  const m = /^\/dashboard(?:\/([a-z-]+))?\/?$/.exec(String(href ?? ''));
  if (!m) return null;
  return pathSegmentToSection(m[1]);
}

// The dashboard calls prefetchHelpData() once it is idle, so opening Help
// usually finds its data already loaded. A prefetched response is handed out
// once: the next visit fetches again, so the form token is never stale.
const prefetched = new Map();

function fetchHelpData(url) {
  return fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))));
}

function loadHelpData(url) {
  const pending = prefetched.get(url);
  if (pending) {
    prefetched.delete(url);
    return pending.catch(() => fetchHelpData(url));
  }
  return fetchHelpData(url);
}

/** Starts loading the plain help URL (no form seed) in this locale. */
export function prefetchHelpData(locale) {
  const url = helpDataUrl(locale, '');
  if (prefetched.has(url)) return;
  const pending = fetchHelpData(url);
  pending.catch(() => {});
  prefetched.set(url, pending);
}

function HelpSkeleton({ label }) {
  return (
    <div className="help-skeleton" role="status" aria-label={label}>
      <div className="help-skeleton-bar help-skeleton-title" />
      <div className="help-skeleton-bar" style={{ width: '60%' }} />
      <div className="help-skeleton-bar help-skeleton-input" />
      {[70, 55, 65, 50].map((w) => <div key={w} className="help-skeleton-bar" style={{ width: `${w}%` }} />)}
    </div>
  );
}

export function HelpSection({ onNavigateSection }) {
  const locale = useLocale();
  const tr = useTranslations('dashboardChrome');
  const [state, setState] = useState({ status: 'loading', data: null, locale });

  // Reset while a new locale loads ("adjust state during render", no effect).
  if (state.locale !== locale) setState({ status: 'loading', data: null, locale });

  useEffect(() => {
    let cancelled = false;
    loadHelpData(helpDataUrl(locale, window.location.search))
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data, locale });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', data: null, locale });
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  if (state.status !== 'ready') {
    return (
      <div className="page">
        {state.status === 'error' ? (
          <p className="help-muted" role="alert">{tr('help.loadError')}</p>
        ) : (
          <HelpSkeleton label={tr('help.loading')} />
        )}
      </div>
    );
  }

  const d = state.data;
  return (
    <div className="page">
      <HelpCenter
        variant="app"
        locale={d.locale}
        copy={d.copy}
        categories={d.categories}
        index={d.index}
        supportCategories={d.ticketCategories}
        form={{
          signedInEmail: d.signedInEmail,
          context: d.context,
          formToken: d.formToken,
          initialCategory: d.form?.initialCategory,
          initialSubject: d.form?.initialSubject,
          providerName: d.form?.providerName,
          meta: d.form?.meta,
          open: d.form?.open,
        }}
        onNavigate={(href) => {
          const section = dashboardSectionFor(href);
          if (!section || !onNavigateSection) return false;
          onNavigateSection(section);
          return true;
        }}
      />
    </div>
  );
}
