import AppLocaleProvider from '../../components/i18n/AppLocaleProvider';

/**
 * Wraps the authenticated dashboard in the client-side locale provider so the
 * app respects the user's language preference (localStorage / browser), without
 * any /nb URL prefix. Auth and session handling are unchanged.
 */
export default function DashboardLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
