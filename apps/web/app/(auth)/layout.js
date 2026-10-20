import '../../styles/dashboard.css';
import AuthLocaleProvider from '../../components/i18n/AuthLocaleProvider';

/**
 * Auth route group layout.
 *
 * Provides the centred dot-grid shell used by all auth screens:
 * /login, /forgot-password, /reset-password.
 *
 * dashboard.css is imported here (in addition to the CSS already loaded by
 * the root layout) because auth forms use .field, .input, and .btn styles
 * defined there. No session check: the proxy handles redirecting
 * already-authenticated users.
 *
 * Wrapped in AuthLocaleProvider so auth screens follow the user's language
 * preference (localStorage / browser) without a URL locale prefix.
 */
export default function AuthLayout({ children }) {
  return <AuthLocaleProvider>{children}</AuthLocaleProvider>;
}
