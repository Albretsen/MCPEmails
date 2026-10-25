'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The one line a friend's invite shows on the home page.
 *
 * /r/<code> redirects here with ?acq=referral (app/r/[code]/route.ts). The
 * home page is statically rendered, so the query is read in the browser after
 * mount rather than on the server: reading searchParams there would make every
 * home page view dynamic for the sake of one line.
 *
 * Fixed to the bottom of the viewport on purpose. It appears after the first
 * paint, and anything in the page flow that appears late pushes the hero down
 * (layout shift). An overlay moves nothing. It never names the friend, the code
 * or an amount, and closing it is remembered only for the page view.
 */
export function ReferralBanner() {
  const t = useTranslations('home.referralBanner');
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const referred = new URLSearchParams(window.location.search).get('acq') === 'referral';
      // A state update from a browser-only read, once, after mount. Deriving it
      // during render would differ between the server and the first client render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (referred) setShow(true);
    } catch {
      // No URL to read: nothing to show.
    }
  }, []);

  if (!show) return null;
  return (
    <div
      role="status"
      data-referral-banner=""
      style={{
        position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 50,
        margin: '0 auto', maxWidth: 560,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 12px 10px 16px', borderRadius: 12,
        background: 'var(--bg-inverse, #0E1430)', color: '#F4F6FD',
        boxShadow: '0 8px 24px rgba(14,20,48,0.18)',
        fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.45,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{t('text')}</span>
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label={t('close')}
        title={t('close')}
        style={{
          flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'rgba(244,246,253,0.7)', fontSize: 18, lineHeight: 1, padding: 6,
        }}
      >
        ×
      </button>
    </div>
  );
}
