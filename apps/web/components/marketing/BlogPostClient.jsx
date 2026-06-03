'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';

function fmtDate(iso, locale) {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Thin top progress bar tracking read position through the article. */
function ReadingProgress({ targetRef }) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = targetRef.current;
      if (!el) return;
      const top = el.offsetTop;
      const total = el.offsetHeight - window.innerHeight;
      const scrolled = window.scrollY - top;
      const p = total > 0 ? Math.min(1, Math.max(0, scrolled / total)) : 0;
      setPct(p * 100);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [targetRef]);
  return (
    <div className="blog-progress" aria-hidden="true">
      <div className="blog-progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Table of contents with scroll-spy active highlighting. */
function Toc({ headings }) {
  const t = useTranslations('blog');
  const [active, setActive] = useState(headings[0]?.id ?? '');
  useEffect(() => {
    if (!headings.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    headings.forEach((h) => {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [headings]);

  if (!headings.length) return null;
  return (
    <nav className="blog-toc" aria-label={t('post.toc')}>
      <div className="blog-toc-title">{t('post.toc')}</div>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? 'toc-sub' : ''}>
            <a
              href={`#${h.id}`}
              className={active === h.id ? 'active' : ''}
              aria-current={active === h.id ? 'true' : undefined}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function BlogPostClient({ post }) {
  const t = useTranslations('blog');
  const locale = useLocale();
  const articleRef = useRef(null);
  const author = post.author;

  return (
    <div>
      <ReadingProgress targetRef={articleRef} />
      <Nav />

      <article className="blog-post">
        <div className="container" style={{ maxWidth: 1080 }}>
          {/* Breadcrumb */}
          <nav className="blog-crumbs" aria-label="Breadcrumb">
            <Link href="/">{t('post.home')}</Link>
            <span aria-hidden="true">/</span>
            <Link href="/blog">{t('post.blog')}</Link>
            <span aria-hidden="true">/</span>
            <span className="blog-crumb-current">{post.title}</span>
          </nav>

          {/* Header */}
          <header className="blog-head">
            <div className="blog-card-tags">
              {post.tags.map((t) => (
                <span className="blog-tag" key={t}>{t}</span>
              ))}
            </div>
            <h1 className="blog-title">{post.title}</h1>
            <p className="blog-lead">{post.description}</p>

            <div className="blog-byline">
              <img
                className="blog-byline-avatar"
                src={author.avatar}
                alt={author.name}
                width={44}
                height={44}
              />
              <div className="blog-byline-text">
                <div className="blog-byline-name">{author.name}</div>
                <div className="blog-byline-meta">
                  <span>{author.role}</span>
                </div>
              </div>
              <div className="blog-byline-divider" />
              <div className="blog-byline-dates">
                <time dateTime={post.publishedAt}>{fmtDate(post.publishedAt, locale)}</time>
                <span className="blog-dot">·</span>
                <span>{t('post.minRead', { minutes: post.readingMinutes })}</span>
              </div>
            </div>
          </header>

          {/* Cover */}
          <figure className="blog-cover">
            <img src={post.cover} alt={post.coverAlt} width={1200} height={630} />
          </figure>

          {/* Body + TOC */}
          <div className="blog-layout">
            <aside className="blog-aside">
              <div className="blog-aside-sticky">
                <Toc headings={post.headings} />
              </div>
            </aside>

            <div className="blog-content" ref={articleRef}>
              <div
                className="blog-prose"
                dangerouslySetInnerHTML={{ __html: post.html }}
              />

              {/* Author bio */}
              <div className="blog-authorcard">
                <img
                  className="blog-authorcard-avatar"
                  src={author.avatar}
                  alt={author.name}
                  width={64}
                  height={64}
                />
                <div>
                  <div className="blog-authorcard-eyebrow">{t('post.writtenBy')}</div>
                  <div className="blog-authorcard-name">{author.name}</div>
                  <p className="blog-authorcard-bio">{author.bio}</p>
                  {author.twitter && (
                    <a
                      className="blog-authorcard-link"
                      href={`https://twitter.com/${author.twitter.replace('@', '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {author.twitter}
                    </a>
                  )}
                </div>
              </div>

              <div className="blog-backrow">
                <Link href="/blog" className="blog-back">{t('post.back')}</Link>
              </div>
            </div>
          </div>
        </div>
      </article>

      {/* CTA band */}
      <section className="pricing-cta-band">
        <div className="container">
          <h2 className="pricing-cta-h">{t('post.cta.title')}</h2>
          <p className="pricing-cta-sub">{t('post.cta.sub')}</p>
          <div className="pricing-cta-btns">
            <a className="btn btn-primary btn-lg" href="/signup">{t('post.cta.primary')}</a>
            <Link className="btn btn-on-dark btn-lg" href="/docs">{t('post.cta.secondary')}</Link>
          </div>
        </div>
      </section>

      <Footer />

      <style>{`
        /* progress bar */
        .blog-progress {
          position: fixed; top: 0; left: 0; right: 0; height: 3px;
          background: transparent; z-index: 60; pointer-events: none;
        }
        .blog-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, var(--cobalt-500), var(--mint-500));
          transition: width .08s linear;
        }

        .blog-post { padding: 40px 0 72px; }

        /* breadcrumb */
        .blog-crumbs {
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
          font-size: 13px; color: var(--fg-3); margin-bottom: 28px;
        }
        .blog-crumbs a { color: var(--fg-3); text-decoration: none; }
        .blog-crumbs a:hover { color: var(--cobalt-600); }
        .blog-crumb-current {
          color: var(--fg-1); max-width: 360px; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap;
        }

        /* header */
        .blog-head { max-width: 760px; margin: 0 auto 32px; text-align: center; }
        .blog-head .blog-card-tags { justify-content: center; }
        .blog-title {
          font-size: clamp(30px, 5vw, 46px); font-weight: 800; line-height: 1.12;
          color: var(--fg-0); margin: 16px 0 0; letter-spacing: -0.02em;
        }
        .blog-lead {
          font-size: clamp(17px, 2.2vw, 20px); line-height: 1.55; color: var(--fg-2);
          margin: 18px auto 0; max-width: 640px;
        }
        .blog-byline {
          display: inline-flex; align-items: center; gap: 14px; flex-wrap: wrap;
          justify-content: center; margin-top: 28px;
        }
        .blog-byline-avatar { border-radius: 999px; display: block; }
        .blog-byline-text { text-align: left; }
        .blog-byline-name { font-size: 14px; font-weight: 700; color: var(--fg-0); }
        .blog-byline-meta { font-size: 13px; color: var(--fg-3); }
        .blog-byline-divider { width: 1px; height: 28px; background: var(--border-1); }
        .blog-byline-dates {
          display: flex; align-items: center; gap: 8px;
          font-size: 13px; color: var(--fg-3);
        }
        .blog-dot { color: var(--fg-4); }

        /* tags (shared look with index) */
        .blog-card-tags { display: flex; flex-wrap: wrap; gap: 8px; }
        .blog-tag {
          font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase;
          color: var(--cobalt-600); background: var(--cobalt-50);
          border: 1px solid var(--cobalt-100); padding: 3px 9px; border-radius: 999px;
        }

        /* cover */
        .blog-cover {
          margin: 0 auto 8px; max-width: 980px; border-radius: var(--radius-lg);
          overflow: hidden; border: 1px solid var(--border-1); background: var(--bg-sunken);
        }
        .blog-cover img { width: 100%; height: auto; display: block; }

        /* layout: content + sticky TOC */
        .blog-layout {
          display: grid; grid-template-columns: 220px minmax(0, 1fr);
          gap: 56px; align-items: stretch; margin-top: 48px;
        }
        /* Full-height column lets the sticky TOC follow the reader through the
           whole article instead of scrolling away after its own short height. */
        .blog-aside { height: 100%; }
        .blog-aside-sticky {
          position: sticky; top: 88px;
          max-height: calc(100vh - 110px); overflow-y: auto;
        }
        .blog-content { max-width: 720px; }

        /* TOC */
        .blog-toc { font-size: 13px; }
        .blog-toc-title {
          font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
          color: var(--fg-4); margin-bottom: 12px;
        }
        .blog-toc ul { list-style: none; margin: 0; padding: 0;
          border-left: 2px solid var(--border-1); }
        .blog-toc li { margin: 0; }
        .blog-toc li.toc-sub a { padding-left: 26px; font-size: 12.5px; }
        .blog-toc a {
          display: block; padding: 6px 0 6px 14px; margin-left: -2px;
          border-left: 2px solid transparent; color: var(--fg-3);
          text-decoration: none; line-height: 1.4; transition: color .12s ease, border-color .12s ease;
        }
        .blog-toc a:hover { color: var(--fg-1); }
        .blog-toc a.active { color: var(--cobalt-600); border-left-color: var(--cobalt-500); font-weight: 600; }

        /* prose */
        .blog-prose { font-family: var(--font-sans); color: var(--fg-1); }
        .blog-prose > *:first-child { margin-top: 0; }
        .blog-prose p { font-size: 17px; line-height: 1.75; color: var(--fg-1); margin: 0 0 22px; }
        .blog-prose h2 {
          font-size: 26px; font-weight: 750; color: var(--fg-0); letter-spacing: -0.01em;
          margin: 48px 0 16px; scroll-margin-top: 88px;
        }
        .blog-prose h3 {
          font-size: 19px; font-weight: 700; color: var(--fg-0);
          margin: 32px 0 12px; scroll-margin-top: 88px;
        }
        .blog-prose ul, .blog-prose ol { margin: 0 0 22px; padding-left: 24px; }
        .blog-prose li { font-size: 17px; line-height: 1.7; color: var(--fg-1); margin-bottom: 10px; }
        .blog-prose a {
          color: var(--cobalt-600); text-decoration: underline; text-underline-offset: 2px;
        }
        .blog-prose a:hover { color: var(--cobalt-700); }
        .blog-prose strong { font-weight: 700; color: var(--fg-0); }
        .blog-prose code {
          font-family: var(--font-mono); font-size: 0.88em; background: var(--bg-sunken);
          padding: 2px 6px; border-radius: 5px; color: var(--fg-1);
        }
        .blog-prose pre {
          background: var(--bg-sunken); border: 1px solid var(--border-1);
          border-radius: var(--radius-lg); padding: 18px 20px; overflow-x: auto; margin: 0 0 24px;
        }
        .blog-prose pre code { background: none; padding: 0; font-size: 13.5px; line-height: 1.6; color: var(--fg-1); }
        .blog-prose blockquote {
          margin: 0 0 24px; padding: 4px 0 4px 22px; border-left: 3px solid var(--cobalt-400);
          color: var(--fg-2); font-size: 18px; font-style: italic; line-height: 1.6;
        }
        .blog-prose hr { border: none; border-top: 1px solid var(--border-1); margin: 40px 0; }
        .blog-prose figure { margin: 0 0 24px; }
        .blog-prose figure img { width: 100%; border-radius: var(--radius-lg); display: block; }
        .blog-prose figcaption { font-size: 13px; color: var(--fg-3); text-align: center; margin-top: 8px; }

        /* author card */
        .blog-authorcard {
          display: flex; gap: 18px; align-items: flex-start; margin: 48px 0 0;
          padding: 24px; border: 1px solid var(--border-1); border-radius: var(--radius-lg);
          background: var(--bg-sunken);
        }
        .blog-authorcard-avatar { border-radius: 999px; flex-shrink: 0; display: block; }
        .blog-authorcard-eyebrow {
          font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
          color: var(--fg-4); margin-bottom: 2px;
        }
        .blog-authorcard-name { font-size: 16px; font-weight: 700; color: var(--fg-0); }
        .blog-authorcard-bio { font-size: 14px; line-height: 1.65; color: var(--fg-2); margin: 8px 0 10px; }
        .blog-authorcard-link {
          font-size: 13px; font-weight: 600; color: var(--cobalt-600); text-decoration: none;
        }
        .blog-authorcard-link:hover { color: var(--cobalt-700); text-decoration: underline; }

        .blog-backrow { margin-top: 40px; }
        .blog-back { font-size: 14px; font-weight: 600; color: var(--cobalt-600); text-decoration: none; }
        .blog-back:hover { text-decoration: underline; }

        @media (max-width: 900px) {
          .blog-layout { grid-template-columns: 1fr; gap: 28px; }
          .blog-aside { display: none; }
          .blog-content { max-width: 720px; margin: 0 auto; }
        }
      `}</style>
    </div>
  );
}
