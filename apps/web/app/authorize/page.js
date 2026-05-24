import { AuthorizeApp } from '../../components/auth/AuthorizeApp';
import '../../styles/marketing.css';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export const metadata = {
  title: 'Authorize · mcpemails',
  description: 'Authorize an agent to access your inboxes',
};

export default function AuthorizePage() {
  return <AuthorizeApp />;
}
