'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Btn } from '../Primitives';
import {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_OTHER_MAX,
  shouldShowHeardAbout,
} from '@/lib/onboarding/heard-about.mjs';

/**
 * HeardAboutCard: "How did you hear about MCPEmails?" on the Overview, once
 * per workspace, for the owner, after the first inbox connects.
 *
 * One click on an option answers; one click on Dismiss closes it. Both hide
 * the card at once and POST to /api/onboarding/heard-about, which stamps
 * workspaces.heard_about_at so the server never sends `pending` again. "Other"
 * opens a short text field (optional, 200 characters) with its own Send.
 *
 * The save is fire and forget: the question is optional, so a failed save is
 * not worth an error line, and the card does not come back in this view.
 *
 * Props:
 *   pending     server read: heard_about_at is NULL (false on a failed read)
 *   inboxCount  live inbox count from the page's array
 *   isOwner     only the owner is asked
 */
export function HeardAboutCard({ pending = false, inboxCount = 0, isOwner = false }) {
  const t = useTranslations('dashboard');
  const [closed, setClosed] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [other, setOther] = useState('');

  if (!shouldShowHeardAbout({ pending, inboxCount, isOwner, closed })) return null;

  const save = (body) => {
    setClosed(true);
    fetch('/api/onboarding/heard-about', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  const pick = (id) => {
    if (id === 'other') {
      setOtherOpen(true);
      return;
    }
    save({ answer: id });
  };

  return (
    <div className="card" style={{ marginTop: 16 }} data-heard-about>
      <div className="card-h">
        <div>
          <div className="title">{t('heardAbout.title')}</div>
          <div className="sub">{t('heardAbout.sub')}</div>
        </div>
        <div className="grow"></div>
        <Btn variant="ghost" size="sm" onClick={() => save({ dismiss: true })}>{t('heardAbout.dismiss')}</Btn>
      </div>
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {HEARD_ABOUT_OPTIONS.map((id) => (
            <Btn
              key={id}
              variant={id === 'other' && otherOpen ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => pick(id)}
            >
              {t(`heardAbout.options.${id}`)}
            </Btn>
          ))}
        </div>
        {otherOpen && (
          <form
            style={{ display: 'flex', gap: 8, alignItems: 'center' }}
            onSubmit={(event) => {
              event.preventDefault();
              save({ answer: 'other', other });
            }}
          >
            <input
              className="input"
              type="text"
              data-heard-other
              aria-label={t('heardAbout.otherLabel')}
              placeholder={t('heardAbout.otherPlaceholder')}
              maxLength={HEARD_ABOUT_OTHER_MAX}
              value={other}
              onChange={(event) => setOther(event.target.value)}
              style={{ flex: 1, minWidth: 0 }}
              autoFocus
            />
            <Btn variant="primary" size="sm" type="submit">{t('heardAbout.send')}</Btn>
          </form>
        )}
      </div>
    </div>
  );
}
