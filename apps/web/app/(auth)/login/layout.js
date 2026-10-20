import AuthLocaleProvider from '../../../components/i18n/AuthLocaleProvider';

/**
 * /login only: adopt `?lang=` from a translated marketing page's "Sign in"
 * link, so the form and the dashboard after it open in the language the
 * visitor was reading. The (auth) layout's provider still wraps this one and
 * follows it (see AppLocaleProvider.jsx). It is a layout of its own so that
 * /forgot-password and /reset-password keep ignoring the parameter, like every
 * other app URL.
 */
export default function LoginLayout({ children }) {
  return <AuthLocaleProvider readLangParam>{children}</AuthLocaleProvider>;
}
