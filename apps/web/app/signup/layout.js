import '../../styles/dashboard.css';
import AuthLocaleProvider from '../../components/i18n/AuthLocaleProvider';

/**
 * Wraps /signup in the client-side locale provider (`?lang=` from a translated
 * marketing page, else localStorage / browser language), and loads
 * dashboard.css for the form design-system styles.
 */
export default function SignupLayout({ children }) {
  return <AuthLocaleProvider readLangParam>{children}</AuthLocaleProvider>;
}
