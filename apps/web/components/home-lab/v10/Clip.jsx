'use client';

import { useEffect, useRef, useState } from 'react';
import s from './Home.module.css';

/**
 * A muted product clip. The poster is a lazy <picture> (AVIF first, phone
 * crop under 768px), so nothing loads until it nears the screen. The video
 * has preload="none", plays only while on screen and never under
 * prefers-reduced-motion: then the poster stays.
 */
export default function Clip({ src, mobileSrc, poster, mobilePoster, width, height, label }) {
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
    <div className={s.clipFrame}>
      <picture className={s.clipPoster}>
        {mobilePoster && (
          <source media="(max-width: 767px)" type="image/avif" srcSet={`${mobilePoster.base}.avif`} width={mobilePoster.w} height={mobilePoster.h} />
        )}
        {mobilePoster && (
          <source media="(max-width: 767px)" type="image/webp" srcSet={`${mobilePoster.base}.webp`} width={mobilePoster.w} height={mobilePoster.h} />
        )}
        <source type="image/avif" srcSet={`${poster}.avif`} />
        <source type="image/webp" srcSet={`${poster}.webp`} />
        <img src={`${poster}.webp`} width={width} height={height} alt={label} loading="lazy" decoding="async" />
      </picture>
      <video
        ref={ref}
        className={s.clip}
        data-playing={playing ? 'true' : 'false'}
        muted
        loop
        playsInline
        preload="none"
        aria-hidden="true"
        tabIndex={-1}
        onPlaying={() => setPlaying(true)}
      >
        {mobileSrc && <source src={mobileSrc} type="video/mp4" media="(max-width: 767px)" />}
        <source src={src} type="video/mp4" />
      </video>
    </div>
  );
}
