import '../../../../styles/dashboard.css';
import AppLocaleProvider from '../../../../components/i18n/AppLocaleProvider';

/**
 * Layout for /auth/fastmail/app-password.
 *
 * Imports dashboard.css so the app-password connection form has access to
 * the full design-system token set (buttons, inputs, color variables), and
 * wraps the screen in AppLocaleProvider for the client-side language.
 *
 * A JS layout file is used here so TypeScript does not complain about the
 * side-effect CSS import (Next.js handles CSS at the bundler level).
 */
export default function AppPasswordLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
