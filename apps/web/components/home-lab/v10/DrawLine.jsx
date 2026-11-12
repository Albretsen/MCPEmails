'use client';

import { useEffect, useRef, useState } from 'react';
import s from './Home.module.css';

/**
 * The how-it-works rule. It is drawn in the server HTML (so it shows with
 * JavaScript off and under reduced motion). After hydration, if it is still
 * below the fold and motion is allowed, it is hidden and then draws itself once
 * (SVG stroke offset) when it enters view, and stays.
 */
export default function DrawLine() {
  const ref = useRef(null);
  const [state, setState] = useState('drawn');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.85) return undefined;
    setState('armed');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState('drawing');
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -25% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <svg ref={ref} className={s.drawLine} data-state={state} viewBox="0 0 8 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d="M4 0 V100" pathLength="1" />
    </svg>
  );
}
