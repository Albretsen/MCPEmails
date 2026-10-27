'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  canDraftWith,
  clientKind,
  curlFirstCall,
  docsPath,
  helpTiers,
  ladderState,
  openClientHref,
  promptKeys,
  restartKind,
} from '@/lib/onboarding/connect-steps.mjs';
import { adaptiveCadence } from '../useOnboardingStatus';
import { assistEvent, memory, noteServerTime, serverNow } from './assist-actions';
import { CopyField, EmailMeButton, PromptBlock } from './ConnectParts';

/**
 * Step 3 in one screen: the Reply radar prompt to paste, one live status line
 * (Waiting for X, X connected, Ask it something) and the timed help.
 * A failed request is not shown here: the AI app usually fixes its own
 * arguments and tries again, so it would only alarm.
 * FirstPromptStep and WaitStep both render this; the flow moves from
 * first_prompt to wait once the app is connected (a handshake, any call, or a
 * connector grant since reset: connectedAtMs), and to it_works on the
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
  const sawHandshake = useRef(ladderState(status, { client }).connected);

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

  const ladder = ladderState(status, { client });

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

  const tiers = timing ? helpTiers(status, { ...timing, client }) : [];
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
  const lead = kind === 'api' ? 'steps.first_prompt.leadApi' : kind === 'code' ? 'steps.first_prompt.leadCode' : 'steps.first_prompt.lead';

  return (
    <section className="onb-panel" data-step={step} data-testid="onb-wait">
      <h1 className="onb-title">{t(ladder.connected ? 'steps.wait.title' : 'steps.first_prompt.title', vars)}</h1>
      <p className="onb-sub">{t(lead, vars)}</p>
      {prompts.replyRadar ? (
        <PromptBlock text={t(prompts.replyRadar)} kind="reply_radar" testId="onb-prompt" />
      ) : (
        <CopyField value={curlFirstCall(mcpUrl, memory.revealedKeys.get(client))} multiline testId="onb-prompt" />
      )}
      {open && (
        <div className="onb-actions onb-actions-wide">
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
        </div>
      )}

      {!ladder.works && timing && timing.nowMs - timing.waitStartedAtMs >= LISTEN_MS
        ? <p className="onb-hint onb-listen">{t('ladder.stopped')}</p>
        : <Listening rung={ladder.rung} clientLabel={clientLabel} />}

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

/** One live line for where the wait is: Waiting for X, X connected, Ask it something. */
function Listening({ rung, clientLabel }) {
  const t = useTranslations('onboarding');
  const id = RUNGS[Math.min(rung, RUNGS.length - 1)];
  return (
    <div className="onb-listen" data-testid="onb-ladder" data-rung={rung}>
      <span className="onb-listen-status" role="status">
        <span className={`onb-pulse${rung > 0 ? ' is-live' : ''}`} aria-hidden="true" />
        <span key={id} className="onb-fade">{t(`ladder.${id}`, { client: clientLabel })}</span>
      </span>
    </div>
  );
}
