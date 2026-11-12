'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A muted product clip. The poster is a lazy <picture> (AVIF first) under the
 * video, so nothing loads until it nears the viewport; the video itself has
 * preload="none", plays only while on screen and never under
 * prefers-reduced-motion (the poster stays).
 */
export default function Clip({ src, webm, posterAvif, posterWebp, width, height, label, className, posterClassName }) {
  const ref = useRef(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) v.play().catch(() => {});
          else v.pause();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <picture className={posterClassName}>
        <source type="image/avif" srcSet={posterAvif} />
        <source type="image/webp" srcSet={posterWebp} />
        <img src={posterWebp} width={width} height={height} alt="" loading="lazy" decoding="async" />
      </picture>
      <video
        ref={ref}
        className={className}
        style={{ opacity: playing ? 1 : 0 }}
        width={width}
        height={height}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
        onPlaying={() => setPlaying(true)}
      >
        {webm && <source src={webm} type="video/webm" />}
        <source src={src} type="video/mp4" />
      </video>
    </>
  );
}
