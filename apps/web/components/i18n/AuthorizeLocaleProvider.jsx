'use client';

import { LocaleRoot, prefetchPreferredLocale } from './LocaleCore';

import enAuth from '../../messages/en/auth.json';
import enCommon from '../../messages/en/common.json';
import enOnboarding from '../../messages/en/onboarding.json';

/**
 * The OAuth consent screen's provider (app/authorize/layout.js): the auth
 * screens' namespaces plus `onboarding`, because a connector-first user in the
 * new onboarding flow connects their mailbox inside consent with the
 * onboarding inbox step (components/auth/AuthorizeInboxStep.jsx). /login and
 * /signup keep AuthLocaleProvider and do not carry the onboarding strings.
 */
const NAMESPACES = ['auth', 'common', 'onboarding'];
const ENGLISH = { auth: enAuth, common: enCommon, onboarding: enOnboarding };

prefetchPreferredLocale(NAMESPACES, ENGLISH);

export default function AuthorizeLocaleProvider({ children, initialLocale = null }) {
  return (
    <LocaleRoot initialLocale={initialLocale} readLangParam={false} namespaces={NAMESPACES} english={ENGLISH}>
      {children}
    </LocaleRoot>
  );
}
