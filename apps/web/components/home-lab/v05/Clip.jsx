'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './Home.module.css';

/**
 * The hero clip: a real product recording, muted. The poster is a lazy
 * <picture> (phone-width AVIF under 768 px), so nothing loads before it is
 * near the screen. The video element has no sources until it is half on
 * screen; it then gets the desktop or phone file, plays, and pauses when it
 * leaves. Under prefers-reduced-motion it never loads: the poster stays.
 * A pause button covers WCAG 2.2.2 for a looping clip.
 */
export default function Clip({ desktop, mobile, label, pauseLabel, playLabel }) {
  const ref = useRef(null);
  const [allowed, setAllowed] = useState(false);
  const [paused, setPaused] = useState(false);
  const [src, setSrc] = useState(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAllowed(!media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video || !allowed || paused) {
      if (video && !video.paused) video.pause();
      return undefined;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!src) {
            const phone = window.matchMedia('(max-width: 767px)').matches;
            setSrc((phone ? mobile : desktop).base);
          } else {
            video.play().catch(() => {});
          }
        } else {
          video.pause();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(video);
    return () => io.disconnect();
  }, [allowed, paused, src, desktop, mobile]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src || paused || !allowed) return;
    video.load();
    video.play().catch(() => {});
  }, [src, paused, allowed]);

  return (
    <div className={styles.clipWrap}>
      <video
        ref={ref}
        className={styles.clip}
        width={desktop.w}
        height={desktop.h}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
        onPlaying={() => setPlaying(true)}
      >
        {src && <source src={`${src}.webm`} type="video/webm" />}
        {src && <source src={`${src}.mp4`} type="video/mp4" />}
      </video>
      <picture className={styles.clipPoster} hidden={playing}>
        <source media="(max-width: 767px)" type="image/avif" srcSet={`${mobile.base}-poster.avif`} width={mobile.w} height={mobile.h} />
        <source media="(max-width: 767px)" type="image/webp" srcSet={`${mobile.base}-poster.webp`} width={mobile.w} height={mobile.h} />
        <source type="image/avif" srcSet={`${desktop.base}-poster.avif`} />
        <img src={`${desktop.base}-poster.webp`} width={desktop.w} height={desktop.h} alt="" loading="lazy" decoding="async" />
      </picture>
      {allowed && (
        <button type="button" className={styles.clipBtn} onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          <span className={styles.dot} aria-hidden="true" />
          {paused ? playLabel : pauseLabel}
        </button>
      )}
    </div>
  );
}
