import { DashboardApp } from '../../components/dashboard/App';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export const metadata = {
  title: 'Dashboard · mcpemails',
  description: 'Manage your mcpemails inboxes and API keys',
};

export default function DashboardPage() {
  return <DashboardApp />;
}
