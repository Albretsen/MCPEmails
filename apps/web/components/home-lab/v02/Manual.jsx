'use client';

import { useEffect, useState } from 'react';

/**
 * The one behaviour island for v02. Everything works without it: chapters are
 * native <details>, the provider picker is CSS (:has on radio inputs), and all
 * copy is in the server HTML. With JavaScript it adds:
 *  - "Open every chapter" / "Close them all" buttons,
 *  - opening the chapter that holds a #fragment (nav links, footer /#how),
 *  - the fade-up (8px, 200ms, once) as a block enters the viewport,
 *  - playing a muted product clip only while it is on screen.
 * Under prefers-reduced-motion there is no fade and clips stay on the poster.
 */
export default function Manual({ rootId, openLabel, closeLabel, className, buttonClassName }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return undefined;
    // Hydration flag: the buttons only do something once this has run.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true);

    const openFor = (hash) => {
      const id = decodeURIComponent((hash || '').replace(/^#/, ''));
      if (!id) return;
      const target = document.getElementById(id);
      if (!target) return;
      let node = target;
      let opened = false;
      while (node) {
        if (node.tagName === 'DETAILS' && !node.open) {
          node.open = true;
          opened = true;
        }
        node = node.parentElement;
      }
      if (opened) target.scrollIntoView();
    };
    openFor(window.location.hash);
    const onHash = () => openFor(window.location.hash);
    window.addEventListener('hashchange', onHash);
    const onClick = (event) => {
      const a = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
      if (a) openFor(a.getAttribute('href'));
    };
    root.addEventListener('click', onClick);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const observers = [];
    const cleanups = [];
    if (!reduce && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.setAttribute('data-in', '');
              io.unobserve(entry.target);
            }
          });
        },
        { rootMargin: '0px 0px -40px 0px' },
      );
      // Only blocks still below the fold wait for the fade; anything already
      // on screen (or inside a closed chapter) is marked shown first, so the
      // switch below never blanks visible content.
      root.querySelectorAll('[data-r]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.top > window.innerHeight) io.observe(el);
        else el.setAttribute('data-in', '');
      });
      root.setAttribute('data-reveal', 'on');
      observers.push(io);

      // A chapter opened in place fades its first blocks up once.
      const onToggle = (event) => {
        const d = event.target;
        if (!(d instanceof HTMLDetailsElement) || !d.open || d.dataset.faded) return;
        d.dataset.faded = '1';
        const items = Array.from(d.querySelectorAll('[data-r]'));
        items.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.top < window.innerHeight) el.removeAttribute('data-in');
          else {
            el.removeAttribute('data-in');
            io.observe(el);
          }
        });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          items.forEach((el) => {
            if (el.getBoundingClientRect().top < window.innerHeight) el.setAttribute('data-in', '');
          });
        }));
      };
      root.addEventListener('toggle', onToggle, true);
      cleanups.push(() => root.removeEventListener('toggle', onToggle, true));

      const clips = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const video = entry.target;
          if (!(video instanceof HTMLVideoElement)) return;
          if (entry.isIntersecting) {
            video.play().catch(() => {});
          } else {
            video.pause();
          }
        });
      }, { threshold: 0.4 });
      root.querySelectorAll('video[data-clip]').forEach((v) => clips.observe(v));
      observers.push(clips);
    }

    return () => {
      window.removeEventListener('hashchange', onHash);
      root.removeEventListener('click', onClick);
      observers.forEach((o) => o.disconnect());
      cleanups.forEach((fn) => fn());
    };
  }, [rootId]);

  const setAll = (open) => {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.querySelectorAll('details[data-chapter]').forEach((d) => {
      d.open = open;
    });
  };

  return (
    <div className={className} style={{ visibility: ready ? 'visible' : 'hidden' }}>
      <button type="button" className={buttonClassName} onClick={() => setAll(true)} disabled={!ready}>
        {openLabel}
      </button>
      <button type="button" className={buttonClassName} onClick={() => setAll(false)} disabled={!ready}>
        {closeLabel}
      </button>
    </div>
  );
}
