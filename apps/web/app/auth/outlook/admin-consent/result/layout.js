import '../../../../../styles/dashboard.css';
import AppLocaleProvider from '../../../../../components/i18n/AppLocaleProvider';

/**
 * Wraps the public admin-consent result screen in the client-side locale
 * provider, like /auth/error. The visitor is usually a Microsoft 365
 * administrator with no MCP Emails account, so the language comes from the
 * browser, not from a stored preference.
 */
export default function AdminConsentResultLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
