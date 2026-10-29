'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CHIP_CLIENT_LABELS,
  MORE_CHIP_CLIENTS,
  PRIMARY_CHIP_CLIENTS,
  chipClientLabel,
} from '@/lib/onboarding/clients.mjs';
import { ClientLogo } from './ClientLogo';

/**
 * The AI app in use: its logo, its name and a chevron (owner feedback F1).
 * Never a blocking screen: the chip sits at the foot of every step, the
 * popover (opening upwards) lists the five common apps
 * and "More apps" opens the rest. Choosing one calls `onChange(id)`; the
 * parent persists it (POST /api/onboarding {client_changed}).
 *
 * Props: client (chip id), onChange(id).
 */
export function ClientChip({ client, onChange }) {
  const t = useTranslations('onboarding');
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(MORE_CHIP_CLIENTS.includes(client));
  const rootRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      // Handled here, so the dialog around it stays open.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function choose(id) {
    setOpen(false);
    if (id !== client) onChange?.(id);
  }

  const options = showMore ? [...PRIMARY_CHIP_CLIENTS, ...MORE_CHIP_CLIENTS] : PRIMARY_CHIP_CLIENTS;

  return (
    <div className="onb-chip" ref={rootRef}>
      <button
        type="button"
        className="onb-chip-change"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${t('chip.using', { client: chipClientLabel(client) })}. ${t('chip.change')}: ${t('chip.label')}`}
        onClick={() => setOpen((v) => !v)}
        data-testid="onb-chip"
      >
        <ClientLogo client={client} size={22} round />
        <span className="onb-chip-label">{chipClientLabel(client)}</span>
        <svg className="onb-chip-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div className="onb-chip-menu" role="menu" id={menuId} aria-label={t('chip.label')}>
          {options.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={id === client}
              className={`onb-chip-option${id === client ? ' is-selected' : ''}`}
              data-client={id}
              onClick={() => choose(id)}
            >
              <ClientLogo client={id} size={20} />
              {CHIP_CLIENT_LABELS[id]}
            </button>
          ))}
          {!showMore && (
            <button type="button" className="onb-chip-option onb-chip-more" onClick={() => setShowMore(true)}>
              {t('chip.more')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
