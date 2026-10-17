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

export function HelpSection({ onNavigateSection }) {
  const locale = useLocale();
  const tr = useTranslations('dashboardChrome');
  const [state, setState] = useState({ status: 'loading', data: null, locale });

  // Reset while a new locale loads ("adjust state during render", no effect).
  if (state.locale !== locale) setState({ status: 'loading', data: null, locale });

  useEffect(() => {
    let cancelled = false;
    fetch(helpDataUrl(locale, window.location.search), { cache: 'no-store', credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
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
        <p className="help-muted" role={state.status === 'error' ? 'alert' : 'status'}>
          {tr(state.status === 'error' ? 'help.loadError' : 'help.loading')}
        </p>
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
