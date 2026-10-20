import '../../styles/dashboard.css';
import AuthLocaleProvider from '../../components/i18n/AuthLocaleProvider';

/**
 * Wraps the workspace invite acceptance flow (/invite/[token]) in the
 * client-side locale provider. Invite/accept logic is unchanged.
 */
export default function InviteLayout({ children }) {
  return <AuthLocaleProvider>{children}</AuthLocaleProvider>;
}
