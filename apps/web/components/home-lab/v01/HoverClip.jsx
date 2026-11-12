'use client';

import { useEffect, useRef, useState } from 'react';
import Poster from './Poster';

/**
 * A clip that shows its still frame (a lazy AVIF picture) until the pointer
 * rests on it or it gets keyboard focus (brief: asset_use-16). Nothing else
 * loads before then. Under prefers-reduced-motion it stays on the still.
 */
export default function HoverClip({ webm, mp4, poster, width, height, label, className, mediaClassName }) {
  const video = useRef(null);
  const [reduced, setReduced] = useState(true);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const start = () => {
    if (reduced) return;
    video.current?.play().catch(() => {});
  };
  const stop = () => video.current?.pause();

  return (
    // Focusable so keyboard users can start the clip the same way a pointer
    // does; it has no other action.
    <div
      className={className}
      style={{ '--ar': `${width} / ${height}`, '--ar-m': `${width} / ${height}` }}
      tabIndex={0}
      role="group"
      aria-label={label}
      onMouseEnter={start}
      onMouseLeave={stop}
      onFocus={start}
      onBlur={stop}
    >
      <video
        ref={video}
        className={mediaClassName}
        muted
        loop
        playsInline
        preload="none"
        width={width}
        height={height}
        aria-hidden="true"
        onPlay={() => setStarted(true)}
      >
        <source src={webm} type="video/webm" />
        <source src={mp4} type="video/mp4" />
      </video>
      {!started && <Poster poster={{ base: poster, width, height }} className={mediaClassName} />}
    </div>
  );
}
