'use client';

import { useSyncExternalStore } from 'react';
import { proPriceNoticeVisible } from '@/lib/stripe/pro-price-change';
import { proPriceNoticeCopy } from '@/lib/stripe/pro-price-notice-copy.mjs';

/**
 * Whether the notice may show, re-checked in the browser after mount so a page
 * cached before the switch instant drops it once the instant has passed.
 */
export function useProPriceNoticeVisible() {
  // Hydrates with the server's answer (the one baked into the cached HTML),
  // then React re-reads the browser's clock, with no hydration mismatch.
  return useSyncExternalStore(subscribeNever, readVisible, readVisible);
}

const subscribeNever = () => () => {};
const readVisible = () => proPriceNoticeVisible();

/**
 * The dated Pro price notice: one line, no timer, no styling that shouts.
 *
 * Renders nothing unless proPriceNoticeVisible() is true, which needs the
 * `announce` switch on, the new price not yet live, and the switch instant not
 * yet passed. The instant is checked again in the browser after mount, so a
 * CDN-cached page built before the switch stops showing the deadline once it
 * has passed, instead of displaying a date that is no longer true.
 *
 * `where` picks the sentence: 'pricing' (both prices, both intervals) or 'app'
 * (the shorter line next to a Pro buy button). `plan`, when given, limits the
 * notice to Pro: the dashboard passes each offered plan and only Pro shows it.
 *
 * @param {{ locale: string, where: 'pricing' | 'app', plan?: string, style?: object, className?: string }} props
 */
export default function ProPriceNotice({ locale, where, plan, style, className }) {
  const visible = useProPriceNoticeVisible();
  if (plan !== undefined && plan !== 'solo') return null;
  if (!visible) return null;

  const copy = proPriceNoticeCopy(locale);
  return (
    <p className={className} style={style} data-testid="pro-price-notice">
      {where === 'pricing' ? copy.pricing : copy.app}
    </p>
  );
}
