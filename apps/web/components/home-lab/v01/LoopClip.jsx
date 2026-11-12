'use client';

import { useEffect, useRef, useState } from 'react';
import Poster from './Poster';

/**
 * The one looping clip in the hero (brief: motion-03). Muted, nothing loads
 * until it plays: the still frame is a lazy AVIF picture over the video. It
 * plays only while on screen, pauses when scrolled away, and has a visible
 * Pause / Play control. Under prefers-reduced-motion it never starts on its
 * own: the still shows until the visitor presses Play. Phones get the
 * phone-width cut; the frame's shape comes from CSS, so nothing shifts.
 */
export default function LoopClip({ desktop, mobile, label, frameClassName, mediaClassName, buttonClassName }) {
  const video = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [small, setSmall] = useState(false);
  const clip = small && mobile ? mobile : desktop;

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const phone = window.matchMedia('(max-width: 767px)');
    const sync = () => {
      setReduced(motion.matches);
      setSmall(phone.matches);
    };
    sync();
    motion.addEventListener('change', sync);
    phone.addEventListener('change', sync);
    return () => {
      motion.removeEventListener('change', sync);
      phone.removeEventListener('change', sync);
    };
  }, []);

  useEffect(() => {
    const el = video.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !userPaused && !reduced) {
          el.play().catch(() => {});
        } else if (!entry.isIntersecting) {
          el.pause();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [userPaused, reduced, small]);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      setUserPaused(false);
      el.play().catch(() => {});
    } else {
      setUserPaused(true);
      el.pause();
    }
  };

  const poster = {
    base: desktop.poster,
    width: desktop.width,
    height: desktop.height,
    mobile: mobile ? { base: mobile.poster, width: mobile.width, height: mobile.height } : null,
  };

  return (
    <div
      className={frameClassName}
      style={{
        '--ar': `${desktop.width} / ${desktop.height}`,
        '--ar-m': mobile ? `${mobile.width} / ${mobile.height}` : `${desktop.width} / ${desktop.height}`,
      }}
    >
      <video
        key={clip.mp4}
        ref={video}
        className={mediaClassName}
        muted
        loop
        playsInline
        preload="none"
        width={clip.width}
        height={clip.height}
        aria-label={label}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
      >
        <source src={clip.webm} type="video/webm" />
        <source src={clip.mp4} type="video/mp4" />
      </video>
      {!started && <Poster poster={poster} className={mediaClassName} />}
      <button type="button" className={buttonClassName} onClick={toggle} aria-pressed={!playing}>
        {playing ? 'Pause clip' : 'Play clip'}
      </button>
    </div>
  );
}
