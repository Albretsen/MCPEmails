'use client';

import { useEffect } from 'react';

// Store only coarse, allowlisted acquisition categories in session storage.
// Raw URLs, UTM values, search terms, and identifiers never leave the browser.
const SOURCES = new Set([
  'direct', 'organic_google', 'reddit', 'github', 'smithery', 'glama', 'cursor', 'other',
]);
const LANDINGS = new Set(['home', 'blog', 'provider', 'docs', 'pricing', 'other']);

function sourceFromHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'google.com' || host.endsWith('.google.com')) return 'organic_google';
  if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'smithery.ai' || host.endsWith('.smithery.ai')) return 'smithery';
  if (host === 'glama.ai' || host.endsWith('.glama.ai')) return 'glama';
  if (host === 'cursor.com' || host.endsWith('.cursor.com')) return 'cursor';
  return 'other';
}

function landingFromPath(pathname) {
  const path = pathname.replace(/^\/(nb|es|fr|zh)(?=\/|$)/, '') || '/';
  if (path === '/') return 'home';
  if (path.startsWith('/blog')) return 'blog';
  if (path.startsWith('/connect/')) return 'provider';
  if (path.startsWith('/docs')) return 'docs';
  if (path.startsWith('/pricing')) return 'pricing';
  return 'other';
}

function readUtmSource(params) {
  const source = params.get('utm_source')?.toLowerCase();
  if (!source) return null;
  if (source.includes('google')) return 'organic_google';
  if (source.includes('reddit')) return 'reddit';
  if (source.includes('github')) return 'github';
  if (source.includes('smithery')) return 'smithery';
  if (source.includes('glama')) return 'glama';
  if (source.includes('cursor')) return 'cursor';
  return 'other';
}

export function readAcquisitionContext() {
  try {
    const raw = window.sessionStorage.getItem('mcpe-acquisition');
    const value = raw ? JSON.parse(raw) : null;
    if (SOURCES.has(value?.source) && LANDINGS.has(value?.landing)) return value;
  } catch (_) {}
  return { source: 'direct', landing: 'other' };
}

export default function AcquisitionCapture() {
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('mcpe-acquisition')) return;
      const url = new URL(window.location.href);
      const utmSource = readUtmSource(url.searchParams);
      let source = utmSource ?? 'direct';
      if (!utmSource && document.referrer) {
        const referrer = new URL(document.referrer);
        if (referrer.origin !== window.location.origin) source = sourceFromHost(referrer.hostname);
      }
      window.sessionStorage.setItem('mcpe-acquisition', JSON.stringify({
        source,
        landing: landingFromPath(url.pathname),
      }));
    } catch (_) {}
  }, []);
  return null;
}
