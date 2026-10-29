import '../../../styles/dashboard.css';
import AuthLocaleProvider from '../../../components/i18n/AuthLocaleProvider';

/**
 * Wraps the /auth/error screen in the client-side locale provider.
 */
export default function AuthErrorLayout({ children }) {
  return <AuthLocaleProvider>{children}</AuthLocaleProvider>;
}
