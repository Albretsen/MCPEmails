'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { chipClientLabel, normalizeChipClient } from '@/lib/onboarding/clients.mjs';

/** Where "Open <client>" goes. Only the two chat apps with a web page to land on. */
const CLIENT_HOME = Object.freeze({
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
});

/**
 * "Connected. Go back to Claude and ask again." The end of a connect that
 * started from a chat (`from=chat`, a signed link from the MCP server's
 * no-inbox answer; src/lib/onboarding/chat-connect-link.ts). Shown on
 * /onboarding and on the dashboard. A copyable first prompt, and a button back
 * to the chat app when it has a web page.
 *
 * Props: client (chip id or null), dashboardHref (optional "Go to the dashboard"
 * link), or onClose (the same as a button, inside the setup dialog).
 * Strings: onboarding.chatReturn.*
 */
export function ChatReturnPanel({ client = null, dashboardHref = null, onClose = null }) {
  const t = useTranslations('onboarding.chatReturn');
  const id = normalizeChipClient(client);
  const label = id ? chipClientLabel(id) : t('yourApp');
  const home = id ? CLIENT_HOME[id] ?? null : null;
  const prompt = t('prompt');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The prompt is on screen to select by hand.
    }
  };

  return (
    <section className="onb-panel onb-chat-return" data-testid="chat-return">
      <h1 className="onb-title">{t('title', { client: label })}</h1>
      <p className="onb-muted">{t('lead', { client: label })}</p>
      <blockquote className="onb-chat-prompt" data-testid="chat-return-prompt">{prompt}</blockquote>
      <div className="onb-actions">
        <button type="button" className="btn btn-secondary" onClick={copy} data-testid="chat-return-copy">
          {copied ? t('copied') : t('copy')}
        </button>
        {home && (
          <a className="btn btn-primary" href={home} target="_blank" rel="noopener noreferrer" data-testid="chat-return-open">
            {t('open', { client: label })}
          </a>
        )}
        {dashboardHref && (
          <a className="btn btn-ghost" href={dashboardHref}>{t('dashboard')}</a>
        )}
        {!dashboardHref && onClose && (
          <button type="button" className="btn btn-ghost" onClick={() => onClose()}>{t('dashboard')}</button>
        )}
      </div>
    </section>
  );
}
