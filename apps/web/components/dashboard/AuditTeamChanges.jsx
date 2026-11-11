'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Security page, owners and admins only: team changes
 * (workspace_audit_events via GET /api/security/audit-log?source=events) and
 * the CSV export links for both lists. Minimal: one list, newest first, the
 * latest 25, and the export for everything else.
 */

export const AUDIT_EVENT_KINDS = [
  'invite_sent',
  'invite_cancelled',
  'invite_accepted',
  'member_removed',
  'member_left',
  'role_changed',
  'inbox_visibility_changed',
  'recipient_rule_changed',
];

/** "Name (email)", the email alone, or a former member. */
export function personLabel(person, t) {
  if (!person) return t('security.personUnknown');
  if (person.name && person.email) return `${person.name} (${person.email})`;
  return person.email || person.name || t('security.personFormer');
}

/** The target of an event, in words. */
export function eventTargetLabel(event, t) {
  const d = event?.details ?? {};
  if (event?.kind === 'inbox_visibility_changed') return typeof d.inbox === 'string' ? d.inbox : '';
  if (event?.kind === 'recipient_rule_changed') {
    if (!Array.isArray(d.to) || d.to.length === 0) return t('security.events.anyRecipient');
    const more = typeof d.to_more === 'number' && d.to_more > 0 ? ` +${d.to_more}` : '';
    return d.to.join(', ') + more;
  }
  if (event?.targetPerson) return personLabel(event.targetPerson, t);
  return typeof event?.target === 'string' ? event.target : '';
}

export function AuditExportLink({ source }) {
  const t = useTranslations('dashboard');
  return (
    <a
      className="btn btn-secondary btn-sm"
      href={`/api/security/audit-log?format=csv&source=${source}`}
      download
      style={{ marginLeft: 'auto' }}
    >
      {t('security.exportCsv')}
    </a>
  );
}

export function AuditTeamChanges() {
  const t = useTranslations('dashboard');
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/security/audit-log?source=events&pageSize=25')
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) {
          setError(typeof data.error === 'string' ? data.error : t('security.errLoadAudit'));
          return;
        }
        setEvents(Array.isArray(data.events) ? data.events : []);
      })
      .catch(() => { if (alive) setError(t('security.networkError')); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-h">
        <div>
          <div className="title">{t('security.events.title')}</div>
          <div className="sub">{t('security.events.sub')}</div>
        </div>
        <AuditExportLink source="events" />
      </div>
      {events === null && !error && (
        <div style={{ padding: '12px 20px', font: '13px var(--font-sans)', color: 'var(--fg-3)' }}>{t('security.events.loading')}</div>
      )}
      {error && (
        <div role="alert" style={{ padding: '12px 20px', font: '13px var(--font-sans)', color: 'var(--red-700)' }}>{error}</div>
      )}
      {events && events.length === 0 && (
        <div style={{ padding: '12px 20px', font: '13px var(--font-sans)', color: 'var(--fg-3)' }}>{t('security.events.empty')}</div>
      )}
      {events && events.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('security.events.colWhen')}</th>
                <th>{t('security.colPerson')}</th>
                <th>{t('security.events.colEvent')}</th>
                <th>{t('security.events.colTarget')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap', font: '12px var(--font-mono)', color: 'var(--fg-3)' }} suppressHydrationWarning>
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td style={{ font: '13px var(--font-sans)', color: 'var(--fg-2)' }}>{personLabel(e.actor, t)}</td>
                  <td style={{ font: '13px var(--font-sans)', color: 'var(--fg-1)' }}>
                    {AUDIT_EVENT_KINDS.includes(e.kind) ? t(`security.events.kinds.${e.kind}`) : e.kind}
                  </td>
                  <td style={{ font: '13px var(--font-sans)', color: 'var(--fg-2)' }}>{eventTargetLabel(e, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
