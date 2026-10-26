'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  canDraftWith,
  clientKind,
  curlFirstCall,
  docsPath,
  failureKey,
  helpTiers,
  ladderState,
  openClientHref,
  promptKeys,
  restartKind,
  visibleFailure,
} from '@/lib/onboarding/connect-steps.mjs';
import { adaptiveCadence } from '../useOnboardingStatus';
import { assistEvent, memory, noteServerTime, serverNow } from './assist-actions';
import { CopyField, EmailMeButton, PromptBlock } from './ConnectParts';

/**
 * A8 in one screen: the Reply radar prompt to paste, the live ladder
 * (Waiting for X, X connected, Ask it something, It works) and the timed help.
 * FirstPromptStep and WaitStep both render this; the flow moves from
 * first_prompt to wait when the handshake shows up, and to it_works on the
 * first successful real-inbox call.
 *
 * "Open in Claude" opens a new chat WITHOUT a prefilled prompt: claude.ai has
 * no documented prefill parameter (`/new?q=` is undocumented and reported to
 * auto-send or to have stopped working), so the user pastes the copied prompt.
 *
 * Times: the help timers run on the server's clock (status.serverTime, moved
 * on by local elapsed time), so a wrong computer clock cannot open help early.
 * The wait start is local time in module memory (it survives the
 * first_prompt -> wait remount) and is mapped onto the server clock.
 */
export function WaitPanel({ step, status, setPolling, client, clientLabel, mcpUrl, goTo }) {
  const t = useTranslations('onboarding');
  const vars = { client: clientLabel };
  // { nowMs, waitStartedAtMs } on the server clock, refreshed every 5 s.
  const [timing, setTiming] = useState(null);
  const shownHelp = useRef(new Set());
  const sawHandshake = useRef(Boolean(status?.handshake?.at));

  useEffect(() => {
    setPolling(adaptiveCadence);
    return () => setPolling(null);
  }, [setPolling]);

  useEffect(() => {
    noteServerTime(status?.serverTime);
  }, [status?.serverTime]);

  useEffect(() => {
    if (memory.waitStartedAt === null) memory.waitStartedAt = Date.now();
    const tick = () => {
      const nowMs = serverNow();
      setTiming({ nowMs, waitStartedAtMs: nowMs - (Date.now() - memory.waitStartedAt) });
    };
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 5000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);

  const ladder = ladderState(status);

  // Move along the steps as the signals arrive.
  useEffect(() => {
    if (ladder.works) {
      goTo('it_works');
      return;
    }
    if (ladder.connected && !sawHandshake.current) {
      sawHandshake.current = true;
      assistEvent('handshake_seen', { client: status?.handshake?.client ?? client });
    }
    if (ladder.connected && step === 'first_prompt') goTo('wait');
  }, [ladder.works, ladder.connected, step, goTo, client, status?.handshake?.client]);

  const tiers = timing ? helpTiers(status, timing) : [];
  useEffect(() => {
    for (const tier of tiers) {
      if (shownHelp.current.has(tier)) continue;
      shownHelp.current.add(tier);
      assistEvent('help_shown', { tier });
    }
  }, [tiers.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const kind = clientKind(client);
  const prompts = promptKeys(client, { canDraft: canDraftWith(status?.credential?.scopes ?? null) });
  const open = openClientHref(client);
  const failure = visibleFailure(status, timing?.waitStartedAtMs ?? NaN);
  const lead = kind === 'api' ? 'steps.first_prompt.leadApi' : kind === 'code' ? 'steps.first_prompt.leadCode' : 'steps.first_prompt.lead';

  return (
    <section className="onb-panel" data-step={step} data-testid="onb-wait">
      <h1 className="onb-title">{t(ladder.connected ? 'steps.wait.title' : 'steps.first_prompt.title', vars)}</h1>
      <p className="onb-muted">{t(lead, vars)}</p>
      {prompts.replyRadar ? (
        <PromptBlock text={t(prompts.replyRadar)} kind="reply_radar" testId="onb-prompt" />
      ) : (
        <CopyField value={curlFirstCall(mcpUrl, memory.revealedKeys.get(client))} multiline testId="onb-prompt" />
      )}
      {open && (
        <div className="onb-actions">
          <a
            className="btn btn-primary"
            href={open}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => assistEvent('open_client_clicked', { client })}
            data-testid="onb-open-client"
          >
            {t('steps.first_prompt.open', vars)}
          </a>
          <span className="onb-muted onb-inline-note">{t('steps.first_prompt.openNote')}</span>
        </div>
      )}

      <Ladder rung={ladder.rung} clientLabel={clientLabel} />
      {!ladder.works && timing && timing.nowMs - timing.waitStartedAtMs >= LISTEN_MS && <p className="onb-muted">{t('ladder.stopped')}</p>}

      {failure && (
        <div className="onb-callout onb-callout-error" role="status" data-testid="onb-failure">
          <p className="onb-strong">{t('failure.title')}</p>
          <p className="onb-callout-body">{t(failureKey(failure.code), vars)}</p>
        </div>
      )}

      {tiers.includes('no_handshake') && (
        <HelpCallout title={t('help.noHandshake.title', vars)} body={t(`help.noHandshake.${restartKind(client)}`, vars)} tier="no_handshake" />
      )}
      {tiers.includes('no_call') && (
        <HelpCallout
          title={t('help.noCall.title', vars)}
          body={t(`help.noCall.${client === 'claude' || client === 'chatgpt' ? client : 'other'}`, vars)}
          tier="no_call"
        />
      )}
      {tiers.includes('reconnect') && (
        <div className="onb-callout" data-testid="onb-help-reconnect">
          <p className="onb-strong">{t('help.reconnect.title')}</p>
          <p className="onb-callout-body">{t('help.reconnect.body', vars)}</p>
          <div className="onb-actions">
            <button type="button" className="btn btn-secondary" onClick={() => goTo('add_to_ai')}>{t('help.reconnect.back')}</button>
            <a className="btn btn-secondary" href={docsPath(client)} target="_blank" rel="noopener noreferrer">{t('help.reconnect.docs', vars)}</a>
            <EmailMeButton kind="help_steps" client={client} label={t('help.reconnect.email')} />
          </div>
        </div>
      )}
    </section>
  );
}

function HelpCallout({ title, body, tier }) {
  return (
    <div className="onb-callout" data-testid={`onb-help-${tier}`}>
      <p className="onb-strong">{title}</p>
      <p className="onb-callout-body">{body}</p>
    </div>
  );
}

const RUNGS = ['waiting', 'connected', 'ask', 'works'];
/** adaptiveCadence stops polling after an hour. */
const LISTEN_MS = 60 * 60 * 1000;

function Ladder({ rung, clientLabel }) {
  const t = useTranslations('onboarding');
  return (
    <ol className="onb-ladder" aria-label={t('ladder.listening', { client: clientLabel })} data-testid="onb-ladder" data-rung={rung}>
      {RUNGS.map((id, index) => {
        const state = index < rung ? 'done' : index === rung ? 'current' : 'todo';
        return (
          <li key={id} className={`onb-rung is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="onb-rung-dot" aria-hidden="true" />
            {t(`ladder.${id}`, { client: clientLabel })}
          </li>
        );
      })}
    </ol>
  );
}
