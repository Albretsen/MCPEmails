import '../../styles/dashboard.css';
import AppLocaleProvider from '../../components/i18n/AppLocaleProvider';

/**
 * Wraps the workspace invite acceptance flow (/invite/[token]) in the
 * client-side locale provider. Invite/accept logic is unchanged.
 */
export default function InviteLayout({ children }) {
  return <AppLocaleProvider>{children}</AppLocaleProvider>;
}
