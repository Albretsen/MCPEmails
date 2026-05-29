import '../../../styles/dashboard.css';
import AppLocaleProvider from '../../../components/i18n/AppLocaleProvider';

/**
 * Wraps the /auth/error screen in the client-side locale provider.
 */
export default function AuthErrorLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
