import '../../styles/dashboard.css';
import AppLocaleProvider from '../../components/i18n/AppLocaleProvider';

/**
 * Wraps /signup in the client-side locale provider (`?lang=` from a translated
 * marketing page, else localStorage / browser language), and loads
 * dashboard.css for the form design-system styles.
 */
export default function SignupLayout({ children }) {
  return <AppLocaleProvider readLangParam>{children}</AppLocaleProvider>;
}
