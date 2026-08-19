'use client';

import { useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';

/**
 * The home page's proof section.
 *
 * This replaces DashboardPreview, which drew a browser frame around
 * app.mcpemails.com (a domain that does not resolve) and filled it with
 * invented numbers. A sceptic being asked to hand over mailbox access can
 * check none of that, so it was worse than showing nothing.
 *
 * Flip DEMO_VIDEO_AVAILABLE once the files below exist under public/demo/.
 * Until then the home page keeps the old section rather than rendering an
 * empty player, so this can be merged and deployed ahead of the recording.
 *
 *   public/demo/demo.mp4          H.264/AAC, 1920x1080, the full ~3:00 cut
 *   public/demo/poster.jpg        first meaningful frame, 1920x1080
 *   public/demo/captions-en.vtt   WebVTT for the full cut
 */
export const DEMO_VIDEO_AVAILABLE = false;

/**
 * Listed sources, in preference order. Only add a format once the file exists:
 * a <source> pointing at a missing file is a guaranteed 404 and a console
 * error on every visit, since the browser tries each one in turn. Add the WebM
 * entry above the MP4 when a VP9/Opus encode ships.
 */
const VIDEO_SOURCES = [{ src: '/demo/demo.mp4', type: 'video/mp4' }];

/**
 * Locales we have a caption track for. Anything not listed falls back to the
 * English track, which is still better than no track at all: the audio is in
 * English either way.
 */
const CAPTION_LOCALES = new Set(['en']);

export function DemoVideo() {
  const t = useTranslations('home');
  const locale = useLocale();
  const videoRef = useRef(null);
  const [started, setStarted] = useState(false);

  // preload="none" keeps the video off the critical path entirely: nothing but
  // the poster is fetched until someone actually asks for it.
  const play = () => {
    setStarted(true);
    const el = videoRef.current;
    if (el) {
      el.play().catch(() => {
        /* Autoplay policy or a codec the browser declined. Native controls
           are already visible, so the viewer can start it themselves. */
      });
    }
  };

  const captionLocale = CAPTION_LOCALES.has(locale) ? locale : 'en';

  return (
    <section className="section demo-video-section" id="demo">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">{t('demo.eyebrow')}</div>
          <h2>{t('demo.title')}</h2>
          <p className="sub">{t('demo.sub')}</p>
        </div>

        <figure className="demo-video-frame">
          <video
            ref={videoRef}
            className="demo-video"
            controls
            playsInline
            preload="none"
            poster="/demo/poster.jpg"
            aria-label={t('demo.player.label')}
            onPlay={() => setStarted(true)}
          >
            {VIDEO_SOURCES.map((s) => (
              <source key={s.src} src={s.src} type={s.type} />
            ))}
            <track
              kind="captions"
              src={`/demo/captions-${captionLocale}.vtt`}
              srcLang={captionLocale}
              label={t('demo.player.captions')}
              default
            />
            {t('demo.player.fallback')}
          </video>

          {!started && (
            <button
              type="button"
              className="demo-video-play"
              onClick={play}
              aria-label={t('demo.player.play')}
            >
              <span className="demo-video-play-icon" aria-hidden="true">
                <svg width="22" height="24" viewBox="0 0 22 24" fill="none">
                  <path d="M21 10.27a2 2 0 0 1 0 3.46L3 23.7A2 2 0 0 1 0 22V2A2 2 0 0 1 3 .3z" fill="currentColor" />
                </svg>
              </span>
              <span className="demo-video-play-text">
                {t('demo.player.play')}
                <span className="demo-video-play-meta">{t('demo.player.runtime')}</span>
              </span>
            </button>
          )}

          <figcaption className="demo-video-caption">{t('demo.caption')}</figcaption>
        </figure>
      </div>
    </section>
  );
}
