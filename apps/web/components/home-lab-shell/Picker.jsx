'use client';

import { useEffect, useState } from 'react';

const COOKIE = 'home_lab';

/**
 * Homepage Lab picker (staging only; see HomeLab.tsx). A small fixed panel at
 * the bottom right (the STAGING ribbon sits bottom left): previous / next, the
 * list of variants with their one-line concepts, and the left and right arrow
 * keys. It is aria-hidden and its buttons are out of the tab order, so it never
 * shows up in a variant's heading outline, landmarks or Lighthouse audits; the
 * arrow keys are the keyboard path. Its strings are lab tooling, not copy.
 */
export default function HomeLabPicker({ variants, current }) {
  const [open, setOpen] = useState(false);
  const index = Math.max(0, variants.findIndex((v) => v.id === current));
  const active = variants[index];

  const go = (id) => {
    try {
      document.cookie = `${COOKIE}=${id}; path=/; max-age=2592000; samesite=lax`;
    } catch {}
    const url = new URL(window.location.href);
    url.searchParams.set('home', id);
    window.location.assign(url.toString());
  };
  const step = (delta) => go(variants[(index + delta + variants.length) % variants.length].id);

  // Remember a variant chosen by URL, so later navigation to plain `/` keeps it.
  useEffect(() => {
    try {
      document.cookie = `${COOKIE}=${current}; path=/; max-age=2592000; samesite=lax`;
    } catch {}
  }, [current]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const btn = {
    font: '600 12px/1 system-ui, sans-serif',
    padding: '6px 9px',
    border: '1px solid #3a3a3a',
    borderRadius: 4,
    background: '#1b1b1b',
    color: '#fff',
    cursor: 'pointer',
  };

  return (
    <div
      aria-hidden="true"
      data-home-lab-picker=""
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        zIndex: 2147483646,
        width: open ? 320 : 'auto',
        maxWidth: 'calc(100vw - 96px)',
        background: '#111',
        color: '#eee',
        border: '1px solid #333',
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,.25)',
        font: '12px/1.4 system-ui, sans-serif',
        padding: 6,
      }}
    >
      {open && (
        <ol style={{ listStyle: 'none', margin: '0 0 6px', padding: 0, maxHeight: '60vh', overflowY: 'auto' }}>
          {variants.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => go(v.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 8px',
                  border: 0,
                  borderRadius: 4,
                  background: v.id === current ? '#2b2b2b' : 'transparent',
                  color: '#fff',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                <span style={{ fontWeight: 600 }}>{v.name}</span>
                <span style={{ display: 'block', color: '#aaa' }}>{v.concept}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" tabIndex={-1} style={btn} onClick={() => step(-1)} title="Previous (left arrow)">
          ←
        </button>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
          style={{ ...btn, flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title="Show all variants"
        >
          {active ? active.name : current}
        </button>
        <button type="button" tabIndex={-1} style={btn} onClick={() => step(1)} title="Next (right arrow)">
          →
        </button>
      </div>
    </div>
  );
}
