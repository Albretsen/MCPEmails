'use client';

import { useTranslations } from 'next-intl';
import { formatAmountCents } from '@/lib/stripe/annual-offer';
import { useAppLocale } from '../i18n/AppLocaleProvider';

/**
 * The Business founder line and places left, on the in-app Business surfaces
 * (connect modal cap panel, inbox-cap notice, billing plan picker).
 *
 * Renders nothing unless the price map carries a founder line, which the
 * server attaches only while the offer is open to this owner and the client
 * drops for zh. Plain text in the surface's own muted colour: no badge, no
 * countdown, nothing that changes as places go.
 *
 * @param {{
 *   founder: { monthlyCents: number, addonMonthlyCents: number, placesLeft: number, placesTotal: number } | null | undefined,
 *   size?: 'sm' | 'md',
 * }} props
 */
export default function FounderPriceNote({ founder, size = 'md' }) {
  const tr = useTranslations('dashboardChrome');
  const { locale } = useAppLocale();
  if (!founder) return null;
  const style = {
    fontFamily: 'var(--font-sans)',
    fontSize: size === 'sm' ? 11.5 : 12.5,
    color: 'var(--fg-3)',
    lineHeight: 1.5,
  };
  return (
    <div data-founder-note="" style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
      <div style={style}>
        {tr('founder.line', {
          price: formatAmountCents(founder.monthlyCents, locale),
          addon: formatAmountCents(founder.addonMonthlyCents, locale),
          total: founder.placesTotal,
        })}
      </div>
      <div style={style}>
        {tr('founder.places', { left: founder.placesLeft, total: founder.placesTotal })}
      </div>
    </div>
  );
}
