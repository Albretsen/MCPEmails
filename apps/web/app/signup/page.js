import { SignupApp } from '../../components/auth/SignupApp';
import '../../styles/marketing.css';
import '../../styles/dashboard.css';
import '../../styles/theme.css';

export const metadata = {
  title: 'Sign up · mcpemails',
  description: 'Create your mcpemails workspace',
};

export default function SignupPage() {
  return <SignupApp />;
}
