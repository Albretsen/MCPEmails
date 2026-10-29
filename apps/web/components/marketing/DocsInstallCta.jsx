'use client';

import { useState, useSyncExternalStore } from 'react';
import { Link } from '@/i18n/navigation';
import { MIcon } from '../MarketingPrimitives';
import { isPhone } from '@/lib/onboarding/connect-steps.mjs';
import { trackProductEvent } from '@/lib/analytics.mjs';

/**
 * The hero buttons of a /docs/<client> page, with the client's one-click
 * install (docsPageInstallAction) up front when it has one.
 *
 * A link (Claude, Cursor, VS Code) becomes the primary button, and signup
 * moves to second. Installing first is the connector path: the client opens
 * our sign-in, which creates the account and connects the inbox, and those
 * signups make their first call more often than web signups do. A command
 * (Claude Code, Codex, Gemini CLI) shows under the usual buttons, ready to
 * copy. On a phone an app link (cursor:, vscode:) has nothing to open, so the
 * page keeps its plain buttons there; Claude's https link still works.
 *
 * The only client component on the page: the rest stays server-rendered.
 */
export default function DocsInstallCta({ action, clientName, signupHref, labels }) {
  const phone = useSyncExternalStore(subscribeNothing, phoneSnapshot, desktopSnapshot);
  const [copied, setCopied] = useState(false);
  const clicked = () => trackProductEvent('install_link_clicked', { client: action.client, surface: 'docs' });
  const web = /^https?:/i.test(action.href ?? '');
  const showLink = action.kind === 'link' && (web || !phone);

  const plain = (
    <>
      <a className="btn btn-primary btn-lg" href={signupHref}>{labels.ctaPrimary}</a>
      <Link className="btn btn-secondary btn-lg" href="/docs">{labels.ctaSecondary}</Link>
    </>
  );

  if (showLink) {
    return (
      <>
        <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
          <a
            className="btn btn-primary btn-lg"
            href={action.href}
            {...(web ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            onClick={clicked}
            data-testid="docs-install-link"
          >
            {action.label}
          </a>
          <a className="btn btn-secondary btn-lg" href={signupHref}>{labels.ctaPrimary}</a>
        </div>
        <p className="docs-install-after">
          {labels.after.replace('{client}', clientName)}
          {action.alt && (
            <>
              {' '}
              <a href={action.alt.href} onClick={clicked}>{action.alt.label}</a>
            </>
          )}
        </p>
        {action.note && <p className="docs-install-after">{action.note}</p>}
      </>
    );
  }

  if (action.kind === 'command' && !phone) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(action.command);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      } catch {
        // No clipboard permission: the command is on screen to select by hand.
      }
      clicked();
    };
    return (
      <>
        <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>{plain}</div>
        <div className="docs-code-wrap docs-install-command" data-testid="docs-install-command">
          <div className="docs-code-bar">
            <span className="docs-code-lang">{labels.command}</span>
            <button type="button" className="copy-btn" onClick={copy} style={{ marginLeft: 'auto' }}>
              <MIcon name="copy" size={12} color="var(--fg-3)" />
              {copied ? labels.copied : labels.copy}
            </button>
          </div>
          <pre className="docs-pre"><code>{action.command}</code></pre>
        </div>
      </>
    );
  }

  return <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>{plain}</div>;
}

const subscribeNothing = () => () => {};
const phoneSnapshot = () => isPhone(navigator.userAgent);
const desktopSnapshot = () => false;
