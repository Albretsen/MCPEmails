import '../../styles/dashboard.css';
import AppLocaleProvider from '../../components/i18n/AppLocaleProvider';

/**
 * Wraps the OAuth consent screen (/authorize) in the client-side locale
 * provider. Authorization logic is unchanged; this only sets the language.
 */
export default function AuthorizeLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
