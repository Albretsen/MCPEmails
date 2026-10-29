'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAppLocale } from '../i18n/LocaleCore';
import { flowBEvent, shownOnce } from './flow-b-actions';
import { formatFlowBDate } from './PlanSummaryCard';

const noteStyle = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  padding: '10px 12px',
  marginBottom: 12,
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-1)',
  borderRadius: 10,
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  color: 'var(--fg-2)',
  lineHeight: 1.5,
};

const linkBtn = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--brand)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  fontWeight: 500,
};

/**
 * B3a: the one in-product note when the 3-day grace ends (Flow B). Says how
 * many days MCPEmails was used and that Free now counts the month's email
 * actions. No offer in it. Dismissing stamps workspaces.grace_end_note_seen_at.
 *
 * @param {{ note: { days: number, today: boolean, since: string }, onGoToUsage?: () => void }} props
 */
export function GraceEndNote({ note, onGoToUsage }) {
  const t = useTranslations('convert.graceNote');
  const { locale } = useAppLocale();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    shownOnce('grace_end_note', 'grace_end_note_shown');
  }, []);
  if (hidden || !note) return null;
  const text = note.today
    ? t('today', { days: note.days })
    : t('since', { days: note.days, date: formatFlowBDate(note.since, locale) });
  return (
    <div role="status" data-grace-end-note={note.days} style={noteStyle}>
      <span style={{ flex: '1 1 260px', minWidth: 0 }}>{text}</span>
      {onGoToUsage && (
        <button type="button" style={linkBtn} onClick={onGoToUsage}>{t('seeUsage')}</button>
      )}
      <button
        type="button"
        aria-label={t('dismiss')}
        title={t('dismiss')}
        data-testid="grace-note-dismiss"
        onClick={() => {
          setHidden(true);
          flowBEvent('grace_end_note_dismissed');
        }}
        style={{ ...linkBtn, color: 'var(--fg-3)', fontSize: 18, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * B3b: the usage meter line on the Overview at 50%, 80% and 100% of the Free
 * allowance (Flow B). Uses the wording the dashboard already uses ("email
 * actions", "Personal removes the monthly cap"). One `usage_meter_shown`
 * row per level per billing period.
 *
 * @param {{ level: 50 | 80 | 100, used: number, cap: number, resetsAt: string, periodStart: string, onSeePlans?: () => void }} props
 */
export function UsageMeterNote({ level, used, cap, resetsAt, periodStart, onSeePlans }) {
  const t = useTranslations('convert.meter');
  const { locale } = useAppLocale();
  useEffect(() => {
    if (!level) return;
    shownOnce(`usage_meter_${level}_${periodStart}`, 'usage_meter_shown', { level, since: periodStart });
  }, [level, periodStart]);
  if (!level) return null;
  const date = formatFlowBDate(resetsAt, locale);
  const tone = level === 100 ? 'var(--red-600, #dc2626)' : level === 80 ? 'var(--amber-600, #d97706)' : 'var(--fg-2)';
  return (
    <div role="status" data-usage-meter={level} style={noteStyle}>
      <span style={{ flex: '1 1 260px', minWidth: 0, color: tone }}>
        {t(`level${level}`, { used, cap, date })}
      </span>
      {level >= 80 && onSeePlans && (
        <button type="button" style={linkBtn} onClick={onSeePlans}>{t('seePlans')}</button>
      )}
    </div>
  );
}
