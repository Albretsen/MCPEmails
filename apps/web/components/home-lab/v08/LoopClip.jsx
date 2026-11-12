'use client';

import { useEffect, useRef, useState } from 'react';
import s from './Home.module.css';

const BASE = '/home-lab/assets/a/card-draft-send-light';

/**
 * The hero clip. The server renders the real poster (children), so the page
 * reads and lays out the same without JavaScript. Once the frame scrolls into
 * view, and only when the visitor has not asked for reduced motion, a muted
 * looping video is laid over the poster. A visible button pauses it.
 */
export default function LoopClip({ children, videoLabel, pauseLabel, playLabel }) {
  const box = useRef(null);
  const video = useRef(null);
  const [src, setSrc] = useState(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof window === 'undefined') return undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSrc(window.matchMedia('(max-width: 767px)').matches ? `${BASE}-mobile` : `${BASE}-desktop`);
          } else if (video.current && !video.current.paused) {
            video.current.pause();
          }
        }
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    const onMotion = () => {
      if (motion.matches) {
        setSrc(null);
      }
    };
    motion.addEventListener('change', onMotion);
    return () => {
      io.disconnect();
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  useEffect(() => {
    const v = video.current;
    if (v && src && !paused) v.play().catch(() => {});
  }, [src, paused]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setPaused(false);
    } else {
      v.pause();
      setPaused(true);
    }
  };

  return (
    <div ref={box} className={s.clipBox}>
      {children}
      {src && (
        <>
          <video
            ref={video}
            className={s.clipVideo}
            aria-label={videoLabel}
            poster={`${src}-poster.webp`}
            muted
            loop
            playsInline
            autoPlay
            preload="none"
          >
            <source src={`${src}.webm`} type="video/webm" />
            <source src={`${src}.mp4`} type="video/mp4" />
          </video>
          <button type="button" className={s.clipToggle} onClick={toggle} aria-pressed={paused}>
            {paused ? playLabel : pauseLabel}
          </button>
        </>
      )}
    </div>
  );
}
