'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { claudeInstallHref, getInstallAction } from '@/lib/clients/install-links.mjs';
import { ONBOARDING_KEY_SCOPES, addToAiDone, configSnippet, isPhone, usesApiKey } from '@/lib/onboarding/connect-steps.mjs';
import { recordActivationEvent } from '@/lib/analytics/record-activation-event';
import { adaptiveCadence } from '../useOnboardingStatus';
import { createOnboardingKey } from './assist-actions';
import { CopyField, EmailMeButton } from './ConnectParts';

/**
 * A6, add MCPEmails to the chosen AI app (plan A6, WP-F).
 *
 * One primary action per client, from install-links.mjs (WP-D): a link
 * (Claude, Cursor, VS Code), a command (Claude Code, Codex, Gemini CLI) or
 * ChatGPT's steps. Clients that take an API key (Cline, JetBrains, curl) get a
 * key created here with Standard scopes and shown once, filled into the setup.
 * On a phone, Claude gets the claude.ai browser path; other clients get
 * "Email me this link", which reopens this step on a computer.
 *
 * Links open in a new tab, so this dialog stays put. It polls the status and
 * moves on by itself once a connector grant or MCP handshake appears that is
 * newer than this step (addToAiDone); coming back to the tab checks at once.
 */
export function AddToAiStep({ step, status, setPolling, client, clientLabel, mcpUrl, goNext }) {
  const t = useTranslations('onboarding');
  const locale = useLocale();
  // Device class from the browser; the server render (and hydration) says desktop.
  const phone = useSyncExternalStore(subscribeNothing, phoneSnapshot, desktopSnapshot);
  const [showHere, setShowHere] = useState(false);
  // On the server's clock: only signals newer than this move the step on.
  const [openedAt] = useState(() => Date.parse(status?.serverTime ?? ''));
  const advanced = useRef(false);

  useEffect(() => {
    setPolling(adaptiveCadence);
    return () => setPolling(null);
  }, [setPolling]);

  useEffect(() => {
    if (advanced.current) return;
    if (addToAiDone(status, { client, openedAtMs: openedAt })) {
      advanced.current = true;
      goNext();
    }
  }, [status, client, goNext, openedAt]);

  const vars = { client: clientLabel };
  let body;
  if (phone && client === 'claude') {
    body = <PhoneClaude mcpUrl={mcpUrl} />;
  } else if (phone && !showHere) {
    body = (
      <>
        <p className="onb-muted">{t('steps.add_to_ai.phone.otherBody', vars)}</p>
        <EmailMeButton kind="add_to_ai" client={client} label={t('actions.emailMe')} primary />
        <div className="onb-actions">
          <button type="button" className="onb-link-btn" onClick={() => setShowHere(true)}>{t('steps.add_to_ai.phone.showHere')}</button>
        </div>
      </>
    );
  } else if (usesApiKey(client)) {
    body = <ApiKeySetup client={client} clientLabel={clientLabel} mcpUrl={mcpUrl} />;
  } else {
    body = <InstallAction client={client} clientLabel={clientLabel} mcpUrl={mcpUrl} locale={locale} />;
  }

  return (
    <section className="onb-panel" data-step={step} data-testid="onb-add-to-ai">
      <h1 className="onb-title">{t('steps.add_to_ai.title', vars)}</h1>
      <p className="onb-sub">{t('steps.add_to_ai.lead', vars)}</p>
      {body}
      <div className="onb-listen">
        <span className="onb-listen-status" role="status">
          <span className="onb-pulse" aria-hidden="true" />
          {t('ladder.waiting', vars)}
        </span>
        <button type="button" className="onb-link-btn" onClick={goNext} data-testid="onb-added">
          {t('steps.add_to_ai.continue')}
        </button>
      </div>
    </section>
  );
}

const subscribeNothing = () => () => {};
const phoneSnapshot = () => isPhone(navigator.userAgent);
const desktopSnapshot = () => false;

/**
 * A web link opens in a new tab so this dialog stays open; an app link
 * (cursor://, vscode:) opens the app and leaves no empty tab behind.
 */
function newTab(href) {
  return /^https?:/i.test(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {};
}

function InstallAction({ client, clientLabel, mcpUrl, locale }) {
  const t = useTranslations('onboarding');
  const vars = { client: clientLabel };
  const action = getInstallAction(client, { locale, mcpUrl });
  const urlField = <CopyField label={t('steps.add_to_ai.urlLabel')} value={mcpUrl} testId="onb-url" />;
  const clicked = () => recordActivationEvent('install_link_clicked', { client });

  if (action?.kind === 'link') {
    return (
      <>
        <div className="onb-actions onb-actions-wide">
          <a className="btn btn-primary" href={action.href} {...newTab(action.href)} onClick={clicked} data-testid="onb-install-link">{action.label}</a>
          {action.alt && <a className="btn btn-secondary" href={action.alt.href} {...newTab(action.alt.href)} onClick={clicked}>{action.alt.label}</a>}
        </div>
        <p className="onb-hint onb-after">{client === 'claude' ? t('steps.add_to_ai.claudeAfter') : t('steps.add_to_ai.linkAfter', vars)}</p>
        {action.note && <p className="onb-hint">{action.note}</p>}
        <details className="onb-details">
          <summary>{t('steps.add_to_ai.manual')}</summary>
          {urlField}
        </details>
      </>
    );
  }
  if (action?.kind === 'command') {
    return (
      <>
        <CopyField label={action.label} value={action.command} testId="onb-command" onCopy={clicked} />
        <p className="onb-hint onb-after">{t('steps.add_to_ai.commandAfter', vars)}</p>
      </>
    );
  }
  if (client === 'chatgpt') {
    return (
      <>
        <ol className="onb-steps" data-testid="onb-chatgpt-steps">
          {['step1', 'step2', 'step3', 'step4'].map((k) => <li key={k}>{t(`steps.add_to_ai.chatgpt.${k}`)}</li>)}
        </ol>
        {urlField}
        <p className="onb-note">{t('steps.add_to_ai.chatgpt.note')}</p>
      </>
    );
  }
  const config = configSnippet(client, mcpUrl);
  if (config) {
    return (
      <>
        <p className="onb-muted">{t('steps.add_to_ai.configLead', { client: clientLabel, file: config.file })}</p>
        <CopyField value={config.text} multiline testId="onb-config" />
      </>
    );
  }
  return (
    <>
      <p className="onb-muted">{t('steps.add_to_ai.genericOauth', vars)}</p>
      {urlField}
    </>
  );
}

function PhoneClaude({ mcpUrl }) {
  const t = useTranslations('onboarding');
  const locale = useLocale();
  const note = getInstallAction('claude', { locale, mcpUrl })?.note;
  return (
    <div data-testid="onb-phone-claude">
      <p className="onb-strong">{t('steps.add_to_ai.phone.claudeTitle')}</p>
      <p className="onb-muted">{t('steps.add_to_ai.phone.claudeBody')}</p>
      <CopyField label={t('steps.add_to_ai.phone.copyLink')} value={claudeInstallHref(mcpUrl)} onCopy={() => recordActivationEvent('install_link_clicked', { client: 'claude' })} />
      {note && <p className="onb-note">{note}</p>}
    </div>
  );
}

function ApiKeySetup({ client, clientLabel, mcpUrl }) {
  const t = useTranslations('onboarding');
  const [state, setState] = useState({ phase: 'creating', key: null, reason: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    createOnboardingKey(client, clientLabel, [...ONBOARDING_KEY_SCOPES]).then((res) => {
      if (!live) return;
      setState(res.ok ? { phase: 'ready', key: res.rawKey, reason: null } : { phase: 'failed', key: null, reason: res.reason });
    });
    return () => { live = false; };
  }, [client, clientLabel, attempt]);

  if (state.phase === 'creating') return <p className="onb-muted">{t('steps.add_to_ai.key.creating', { client: clientLabel })}</p>;
  if (state.phase === 'failed') {
    return (
      <div data-testid="onb-key-failed">
        <p className="onb-error" role="alert">{t(state.reason === 'limit' ? 'steps.add_to_ai.key.limit' : 'steps.add_to_ai.key.failed')}</p>
        <div className="onb-actions">
          <button type="button" className="btn btn-secondary" onClick={() => { setState({ phase: 'creating', key: null, reason: null }); setAttempt((n) => n + 1); }}>{t('steps.add_to_ai.key.retry')}</button>
        </div>
      </div>
    );
  }
  const header = `Authorization: Bearer ${state.key}`;
  return (
    <div data-testid="onb-key-ready">
      <p className="onb-note">{t('steps.add_to_ai.key.ready', { client: clientLabel })}</p>
      {client === 'curl' ? (
        <p className="onb-muted">{t('steps.add_to_ai.curl')}</p>
      ) : (
        <ol className="onb-steps">
          {['step1', 'step2', 'step3'].map((k) => <li key={k}>{t(`steps.add_to_ai.${client}.${k}`)}</li>)}
        </ol>
      )}
      <CopyField label={t('steps.add_to_ai.urlLabel')} value={mcpUrl} />
      <CopyField label={client === 'curl' ? t('steps.add_to_ai.key.label') : t('steps.add_to_ai.key.header')} value={client === 'curl' ? state.key : header} testId="onb-key-value" />
    </div>
  );
}
