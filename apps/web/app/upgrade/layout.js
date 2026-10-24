import '../../styles/dashboard.css';
import '../../styles/theme.css';

/**
 * Shell for the two pages a chat checkout link lands on (/upgrade/done and
 * /upgrade/expired). Outside app/[locale] like /approvals, and with no message
 * provider at all: the copy is picked on the server from ./copy.mjs and passed
 * down as props, so these pages ship no next-intl catalog.
 *
 * dashboard.css carries the `.review-*` card styles the send-review page uses,
 * which fit a one-question page like these.
 */
export default function UpgradeLayout({ children }) {
  return children;
}
