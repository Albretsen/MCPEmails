import '../../styles/dashboard.css';
import AuthorizeLocaleProvider from '../../components/i18n/AuthorizeLocaleProvider';

/**
 * Wraps the OAuth consent screen (/authorize) in the client-side locale
 * provider. Authorization logic is unchanged; this only sets the language.
 */
export default function AuthorizeLayout({ children }) {
  return <AuthorizeLocaleProvider>{children}</AuthorizeLocaleProvider>;
}
