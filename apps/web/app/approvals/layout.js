import '../../styles/dashboard.css';
import '../../styles/theme.css';
import AppLocaleProvider from '../../components/i18n/AppLocaleProvider';

/**
 * Wraps the authenticated send-review page (/approvals/[id]) in the
 * client-side locale provider, matching the dashboard realm: these routes are
 * not URL-localized, the language comes from the user's stored preference.
 */
export default function ApprovalsLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
