import '../../styles/theme.css';
import '../../styles/onboarding.css';

/**
 * The static shell, painted at once while page.tsx checks the session and the
 * workspace's arm. No client code and no copy: it is the same frame the page
 * renders, empty, so nothing shifts when the page arrives.
 */
export default function OnboardingLoading() {
  return (
    <div className="onb-root" aria-busy="true">
      <header className="onb-header">
        <span className="onb-brand">MCPEmails</span>
      </header>
      <main className="onb-main" />
    </div>
  );
}
