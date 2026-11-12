'use client';

import { useEffect } from 'react';

/**
 * Space Mono is only used below the first screen (addresses, prompts, code),
 * so it is not declared in the CSS. This loads it with the FontFace API once
 * section 01 comes within 800px of the viewport. Until then those lines use
 * the system monospace, which is close in width.
 */
export default function MonoFont({ url }) {
  useEffect(() => {
    if (typeof FontFace === 'undefined' || typeof IntersectionObserver === 'undefined') return undefined;
    const target = document.querySelector('[data-v10-mono]');
    if (!target) return undefined;
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (done || !entries.some((e) => e.isIntersecting)) return;
        done = true;
        io.disconnect();
        const face = new FontFace('V10 Mono', `url(${url}) format('woff2')`, { weight: '400', style: 'normal', display: 'swap' });
        face.load().then((f) => document.fonts.add(f)).catch(() => {});
      },
      { rootMargin: '800px 0px 800px 0px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [url]);
  return null;
}
