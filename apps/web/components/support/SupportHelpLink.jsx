'use client';

/**
 * SupportHelpLink: a "Help & support" link to /help for surfaces that have no
 * server-side view of the visitor (app/error.js, app/not-found.js,
 * app/global-error.js and the marketing footer, all statically rendered or
 * rendered outside any request that could read the session).
 *
 * SUPPORT_RELEASE_GATE. In v1 /help is internal-only, so this asks the server
 * whether THIS visitor may see it (`GET /api/support/visibility`: 204 visible,
 * 404 not) and renders nothing until the answer is 204. At release the gate
 * goes away and this whole component becomes a plain `<a href="/help">`: delete
 * the effect, the cookie check and the cache, keep the anchor.
 *
 * Why the cookie pre-check. The footer is on every marketing page, and nearly
 * every visitor there is signed out. Without the check each of those page views
 * would fire a request that can only ever answer 404. Only a visitor carrying a
 * Supabase auth cookie (`sb-...-auth-token`, possibly chunked as `.0`, `.1`) or
 * the support preview cookie can be visible at all, so anyone else makes zero
 * requests and gets nothing rendered. The cookie is only a hint: the server
 * still decides.
 *
 * The answer is cached in sessionStorage for the tab so moving between
 * marketing pages asks once. Storage can throw (privacy modes, blocked site
 * data), so every access is wrapped and a failure just means asking again.
 *
 * No next-intl here on purpose: global-error.js replaces the root layout and
 * has no providers, so the label comes in as a prop (English by default, which
 * matches the English-only error pages; the footer passes its translation and
 * its locale-aware Link).
 */

import { useEffect, useState } from 'react';

export const SUPPORT_VISIBILITY_CACHE_KEY = 'mcpe_support_visible';
const PREVIEW_COOKIE = 'mcpe_support_preview';

/** True when the cookie string could belong to someone the gate might admit. */
export function mightSeeSupport(cookieString) {
  if (typeof cookieString !== 'string' || cookieString === '') return false;
  return cookieString.split(';').some((part) => {
    const name = part.split('=')[0].trim();
    return name === PREVIEW_COOKIE || (name.startsWith('sb-') && name.includes('auth-token'));
  });
}

function readCache() {
  try {
    const v = window.sessionStorage.getItem(SUPPORT_VISIBILITY_CACHE_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeCache(visible) {
  try {
    window.sessionStorage.setItem(SUPPORT_VISIBILITY_CACHE_KEY, visible ? '1' : '0');
  } catch {
    /* storage unavailable: we simply ask again next time */
  }
}

export function SupportHelpLink({
  href = '/help',
  label = 'Help & support',
  className,
  style,
  LinkComponent = 'a',
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!mightSeeSupport(document.cookie)) return undefined;
    const cached = readCache();
    if (cached !== null) {
      // Applies the per-tab cached answer after mount; the first paint is
      // always "nothing" so server and client markup agree.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(cached);
      return undefined;
    }
    let cancelled = false;
    // SUPPORT_RELEASE_GATE: the visibility probe disappears at release.
    fetch('/api/support/visibility', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => {
        const ok = res.status === 204;
        writeCache(ok);
        if (!cancelled) setVisible(ok);
      })
      .catch(() => {
        /* network failure: render nothing, cache nothing */
      });
    return () => { cancelled = true; };
  }, []);

  if (!visible) return null;
  return (
    <LinkComponent href={href} className={className} style={style}>
      {label}
    </LinkComponent>
  );
}

export default SupportHelpLink;
