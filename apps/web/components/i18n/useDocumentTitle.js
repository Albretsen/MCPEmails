'use client';

import { useEffect } from 'react';

/** The suffix the root layout's title template adds (app/layout.js). */
const SUFFIX = ' · MCPEmails';

/**
 * Keeps the browser tab's title in the language the screen shows.
 *
 * /signup and /login render outside app/[locale], so their server-side title
 * only knows the language when the link carried `?lang=` (see
 * src/i18n/auth-page-metadata.ts). A visitor whose language comes from the
 * stored choice or the browser instead would keep the English tab title above
 * a translated form. This runs once the catalog is on screen and rewrites the
 * title from the same string the heading uses.
 */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return;
    try {
      document.title = `${title}${SUFFIX}`;
    } catch {
      /* no-op outside a browser */
    }
  }, [title]);
}
