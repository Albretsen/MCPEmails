import OnboardingLocaleProvider from '../../components/i18n/OnboardingLocaleProvider';
import '../../styles/theme.css';
import '../../styles/dashboard.css';
import '../../styles/onboarding.css';
import '../../styles/onboarding-inbox.css';

/**
 * /onboarding: the new post-signup setup flow (onb_flow = new). Its own
 * locale provider with only the `onboarding` namespace, so none of the
 * dashboard's copy or code is in this route's first load.
 */
export const metadata = {
  // Absolute: the root template would add a second ' · MCPEmails'.
  title: { absolute: 'Set up MCPEmails' },
  robots: { index: false, follow: false },
};

export default function OnboardingLayout({ children }) {
  return <OnboardingLocaleProvider>{children}</OnboardingLocaleProvider>;
}
