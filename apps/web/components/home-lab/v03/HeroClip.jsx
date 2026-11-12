'use client';

import { useState } from 'react';
import styles from './Home.module.css';

const A = '/home-lab/assets/a/card-draft-send-light';

/**
 * The page's one clip. Static until the visitor presses play (the brief asks
 * for no motion), so the server renders the real card still at 1:1; under
 * prefers-reduced-motion the play button is hidden and only the still shows.
 */
export default function HeroClip({ alt, videoLabel, play, playLong }) {
  const [playing, setPlaying] = useState(false);
  const [mobile, setMobile] = useState(false);

  if (playing) {
    const v = mobile ? `${A}-mobile` : `${A}-desktop`;
    return (
      <div className={styles.clipBox}>
        <video
          className={styles.clipMedia}
          aria-label={videoLabel}
          poster={`${v}-poster.webp`}
          width={mobile ? 392 : 714}
          height={mobile ? 360 : 420}
          muted
          loop
          playsInline
          autoPlay
          controls
          preload="none"
        >
          <source src={`${v}.webm`} type="video/webm" />
          <source src={`${v}.mp4`} type="video/mp4" />
        </video>
      </div>
    );
  }

  return (
    <div className={styles.clipBox}>
      <picture>
        <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}-mobile-poster.avif`} width={392} height={360} />
        <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}-mobile-poster.webp`} width={392} height={360} />
        <source type="image/avif" srcSet={`${A}-desktop-poster.avif`} width={714} height={420} />
        <img
          className={styles.clipMedia}
          src={`${A}-desktop-poster.webp`}
          width={714}
          height={420}
          alt={alt}
          decoding="async"
        />
      </picture>
      <button
        type="button"
        className={styles.playBtn}
        aria-label={playLong}
        onClick={() => {
          setMobile(window.matchMedia('(max-width: 767px)').matches);
          setPlaying(true);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
          <path d="M3 1.5v11l9-5.5z" fill="currentColor" />
        </svg>
        <span>{play}</span>
      </button>
    </div>
  );
}
