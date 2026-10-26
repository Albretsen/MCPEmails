'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { assistEvent, emailMe } from './assist-actions';

/** Copy text to the clipboard; resolves true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A read-only value with a Copy button. `multiline` renders a code block.
 * `onCopy` runs after a successful copy (funnel events).
 */
export function CopyField({ label, value, multiline = false, onCopy, testId }) {
  const t = useTranslations('onboarding');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      onCopy?.();
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <div className="onb-copy" data-testid={testId}>
      {label && <div className="onb-copy-label">{label}</div>}
      <div className="onb-copy-row">
        {multiline ? <pre className="onb-copy-value">{value}</pre> : <code className="onb-copy-value">{value}</code>}
        <button type="button" className="btn btn-secondary onb-copy-btn" onClick={copy}>
          {copied ? t('actions.copied') : t('actions.copy')}
        </button>
      </div>
    </div>
  );
}

/** A prompt to paste, with Copy (records onboarding_prompt_copied). */
export function PromptBlock({ text, kind, testId }) {
  return (
    <CopyField
      value={text}
      multiline
      testId={testId}
      onCopy={() => assistEvent('prompt_copied', { prompt: kind })}
    />
  );
}

/**
 * "Email me this link" / "Email me the steps": one service email to the
 * signed-in user's own address. One line of result under the button.
 */
export function EmailMeButton({ kind, client, label, primary = false }) {
  const t = useTranslations('onboarding');
  const locale = useLocale();
  const [state, setState] = useState({ phase: 'idle', email: null });
  const send = async () => {
    setState({ phase: 'sending', email: null });
    const res = await emailMe(kind, client, locale);
    setState({ phase: res.ok ? 'sent' : 'failed', email: res.email });
  };
  return (
    <div className="onb-email-me">
      <button
        type="button"
        className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`}
        onClick={send}
        disabled={state.phase === 'sending' || state.phase === 'sent'}
        data-testid={`onb-email-${kind}`}
      >
        {label}
      </button>
      {state.phase === 'sent' && <p className="onb-muted onb-inline-note">{t('actions.emailSent', { email: state.email ?? '' })}</p>}
      {state.phase === 'failed' && <p className="onb-error onb-inline-note" role="alert">{t('actions.emailFailed')}</p>}
    </div>
  );
}
