'use client';

import { useLocale, useTranslations } from 'next-intl';

/**
 * The home page's demo video section, shown only to the treatment arm of the
 * homepage A/B test. HomeClient renders it when showDemoVideo is true; the
 * control arm never mounts it, so nothing about today's page changes.
 *
 * The assets are same origin under public/demo/ on purpose. The production CSP
 * sets no media-src, so it falls back to default-src 'self' and no third party
 * host would load (see src/lib/csp.ts).
 *
 *   public/demo/connect-and-triage-v2.mp4   H.264/AAC cut, no burned in captions
 *   public/demo/connect-and-triage-v2.jpg   poster frame
 *   public/demo/connect-and-triage.<lang>.vtt  WebVTT subtitles, one per locale
 *
 * The files are cached immutable for a year by next.config.js, so a re-cut has
 * to ship under a new filename rather than overwrite these.
 *
 * Only the MP4 is listed as a source. A <source> pointing at a file that does
 * not exist is a guaranteed 404 and a console error on every visit, because the
 * browser tries each source in turn. Add a WebM entry only once that file ships.
 *
 * The tracks are kind="subtitles" rather than "captions": the audio is an
 * English voiceover and the non English files are translations of it, which is
 * exactly what the subtitles kind means. The English track is a transcript of
 * the same speech and rides along under the same kind so the browser's track
 * menu presents one homogeneous language list.
 */
const VIDEO_SRC = '/demo/connect-and-triage-v2.mp4';
const POSTER_SRC = '/demo/connect-and-triage-v2.jpg';

/**
 * Labels are written in each track's own language, which is the convention the
 * native track picker expects: a French speaker looking for French subtitles
 * scans for "Français", not for whatever the page locale calls French.
 */
const SUBTITLE_TRACKS = [
  { locale: 'en', label: 'English' },
  { locale: 'es', label: 'Español' },
  { locale: 'fr', label: 'Français' },
  { locale: 'nb', label: 'Norsk bokmål' },
  { locale: 'zh', label: '中文' },
];

const DEFAULT_TRACK_LOCALE = 'en';

export function DemoVideo() {
  const t = useTranslations('home');
  const locale = useLocale();

  // A locale with no track of its own falls back to English rather than to no
  // default at all, so every visitor gets subtitles on play.
  const activeTrackLocale = SUBTITLE_TRACKS.some((track) => track.locale === locale)
    ? locale
    : DEFAULT_TRACK_LOCALE;

  return (
    <section className="section demo-video-section" id="demo">
      <div className="container">
        <div className="section-head">
          <div className="eye-label">{t('demo.eyebrow')}</div>
          <h2>{t('demo.title')}</h2>
          <p className="sub">{t('demo.sub')}</p>
        </div>

        <figure className="demo-video-frame">
          {/* No autoplay and no muted: playback is user initiated through the
              native controls. preload="metadata" keeps the video bytes off the
              critical path, so a visitor who never plays it pays for the poster
              and a few kilobytes of container header. */}
          <video
            className="demo-video"
            controls
            playsInline
            preload="metadata"
            poster={POSTER_SRC}
            aria-label={t('demo.player.label')}
          >
            <source src={VIDEO_SRC} type="video/mp4" />
            {SUBTITLE_TRACKS.map((track) => (
              <track
                key={track.locale}
                kind="subtitles"
                src={`/demo/connect-and-triage.${track.locale}.vtt`}
                srcLang={track.locale}
                label={track.label}
                default={track.locale === activeTrackLocale}
              />
            ))}
            {t('demo.player.fallback')}
          </video>
          <figcaption className="demo-video-caption">{t('demo.caption')}</figcaption>
        </figure>
      </div>
    </section>
  );
}

export default DemoVideo;
