'use client';

import { LocaleRoot, prefetchPreferredLocale } from './LocaleCore';

import enAuth from '../../messages/en/auth.json';
import enCommon from '../../messages/en/common.json';

/**
 * AppLocaleProvider for the screens before the dashboard: /signup, /login,
 * forgot and reset password, /authorize (OAuth consent), /invite and the auth
 * result pages. Same language rules, same storage key, same `readLangParam`
 * and `initialLocale`; it only carries the `auth` and `common` namespaces,
 * because nothing under these layouts reads `dashboard` or `dashboardChrome`
 * (about 82 KB per language). A screen that starts to use one must move to
 * AppLocaleProvider, or next-intl prints the key path.
 */
const NAMESPACES = ['auth', 'common'];
const ENGLISH = { auth: enAuth, common: enCommon };

prefetchPreferredLocale(NAMESPACES, ENGLISH);

export default function AuthLocaleProvider({ children, initialLocale = null, readLangParam = false }) {
  return (
    <LocaleRoot initialLocale={initialLocale} readLangParam={readLangParam} namespaces={NAMESPACES} english={ENGLISH}>
      {children}
    </LocaleRoot>
  );
}
