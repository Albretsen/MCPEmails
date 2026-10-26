'use client';

import { LocaleRoot, prefetchPreferredLocale } from './LocaleCore';

import enOnboarding from '../../messages/en/onboarding.json';
import enCommon from '../../messages/en/common.json';

/**
 * AppLocaleProvider for /onboarding. Same language rules and storage key as
 * the dashboard (see AppLocaleProvider.jsx), but only the `onboarding` and
 * `common` namespaces: the flow must not ship the dashboard's ~82 KB of copy
 * per language (performance budget, plan section 3 A9). Every string the
 * onboarding panels use lives in messages/<locale>/onboarding.json.
 */
const NAMESPACES = ['onboarding', 'common'];
const ENGLISH = { onboarding: enOnboarding, common: enCommon };

prefetchPreferredLocale(NAMESPACES, ENGLISH);

export default function OnboardingLocaleProvider({ children, initialLocale = null }) {
  return (
    <LocaleRoot initialLocale={initialLocale} readLangParam={false} namespaces={NAMESPACES} english={ENGLISH}>
      {children}
    </LocaleRoot>
  );
}
