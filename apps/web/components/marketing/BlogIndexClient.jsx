'use client';

import { useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';

function fmtDate(iso, locale) {
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function PostCard({ post, t, locale }) {
  return (
    <Link href={`/blog/${post.slug}`} className="blog-card">
      <div className="blog-card-media">
        <img src={post.cover} alt={post.coverAlt} loading="lazy" decoding="async" />
      </div>
      <div className="blog-card-body">
        <div className="blog-card-tags">
          {post.tags.slice(0, 2).map((tag) => (
            <span className="blog-tag" key={tag}>{tag}</span>
          ))}
        </div>
        <h2 className="blog-card-title">{post.title}</h2>
        <p className="blog-card-desc">{post.description}</p>
        <div className="blog-card-meta">
          <img
            className="blog-avatar"
            src={post.author.avatar}
            alt={post.author.name}
            width={24}
            height={24}
          />
          <span className="blog-card-author">{post.author.name}</span>
          <span className="blog-dot">·</span>
          <time dateTime={post.publishedAt}>{fmtDate(post.publishedAt, locale)}</time>
          <span className="blog-dot">·</span>
          <span>{t('index.minRead', { minutes: post.readingMinutes })}</span>
        </div>
      </div>
    </Link>
  );
}

export default function BlogIndexClient({ posts }) {
  const t = useTranslations('blog');
  const locale = useLocale();
  // Distinct tags across all posts, ordered by how often they appear so the
  // most useful filters sit first.
  const tags = useMemo(() => {
    const counts = new Map();
    for (const p of posts) {
      for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [posts]);

  const [active, setActive] = useState('All');
  const filtered = useMemo(
    () => (active === 'All' ? posts : posts.filter((p) => p.tags.includes(active))),
    [posts, active],
  );

  return (
    <div>
      <Nav />

      {/* Header */}
      <section className="blog-index-head">
        <div className="container">
          <div className="eye-label">{t('index.eyebrow')}</div>
          <h1 className="blog-index-h1">{t('index.title')}</h1>
          <p className="blog-index-lead">{t('index.lead')}</p>

          {/* Tag filter */}
          <div className="blog-filter" role="tablist" aria-label={t('index.filterAria')}>
            <button
              type="button"
              role="tab"
              aria-selected={active === 'All'}
              className={'blog-chip' + (active === 'All' ? ' is-active' : '')}
              onClick={() => setActive('All')}
            >
              {t('index.all')}
              <span className="blog-chip-count">{posts.length}</span>
            </button>
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={active === t}
                className={'blog-chip' + (active === t ? ' is-active' : '')}
                onClick={() => setActive(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Posts */}
      <section className="blog-index-body">
        <div className="container">
          <div className="blog-grid">
            {filtered.map((p) => (
              <PostCard key={p.slug} post={p} t={t} locale={locale} />
            ))}
          </div>
          {filtered.length === 0 && (
            <p className="blog-empty">{t('index.empty', { tag: active })}</p>
          )}
        </div>
      </section>

      <Footer />

      <style>{`
        .blog-index-head {
          padding: 56px 0 28px;
          border-bottom: 1px solid var(--border-1);
        }
        .blog-index-head .container { max-width: 1120px; }
        .blog-index-h1 {
          font-size: clamp(30px, 4.5vw, 44px);
          font-weight: 800;
          letter-spacing: -0.02em;
          line-height: 1.1;
          color: var(--fg-0);
          margin: 12px 0 0;
        }
        .blog-index-lead {
          font-size: clamp(16px, 2vw, 18px);
          line-height: 1.55;
          color: var(--fg-2);
          margin: 14px 0 0;
          max-width: 620px;
        }

        /* Filter chips */
        .blog-filter {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 28px;
        }
        .blog-chip {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 13px;
          font-weight: 600;
          color: var(--fg-2);
          background: var(--bg-surface, var(--bg-1));
          border: 1px solid var(--border-1);
          padding: 7px 14px;
          border-radius: 999px;
          cursor: pointer;
          transition: border-color .15s ease, color .15s ease, background .15s ease;
        }
        .blog-chip:hover { border-color: var(--cobalt-300); color: var(--fg-0); }
        .blog-chip.is-active {
          color: #fff;
          background: var(--cobalt-600);
          border-color: var(--cobalt-600);
        }
        .blog-chip-count {
          font-size: 11px;
          font-weight: 700;
          opacity: .7;
        }

        /* Body + uniform grid */
        .blog-index-body { padding: 36px 0 88px; }
        .blog-index-body .container { max-width: 1120px; }
        .blog-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 24px;
        }
        @media (max-width: 920px) {
          .blog-grid { grid-template-columns: repeat(2, 1fr); }
        }
        @media (max-width: 600px) {
          .blog-grid { grid-template-columns: 1fr; }
        }

        .blog-card {
          display: flex;
          flex-direction: column;
          text-decoration: none;
          border: 1px solid var(--border-1);
          border-radius: var(--radius-lg);
          overflow: hidden;
          background: var(--bg-surface, var(--bg-1));
          height: 100%;
          transition: border-color .15s ease, transform .15s ease, box-shadow .15s ease;
        }
        .blog-card:hover {
          border-color: var(--cobalt-300);
          transform: translateY(-3px);
          box-shadow: 0 14px 34px -16px rgba(20,40,90,0.22);
        }
        .blog-card-media {
          background: var(--bg-sunken);
          aspect-ratio: 1200 / 630;
          overflow: hidden;
        }
        .blog-card-media img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform .3s ease;
        }
        .blog-card:hover .blog-card-media img { transform: scale(1.03); }

        .blog-card-body {
          padding: 18px 20px 20px;
          display: flex;
          flex-direction: column;
          flex: 1;
          gap: 10px;
        }
        .blog-card-tags { display: flex; flex-wrap: wrap; gap: 6px; }
        .blog-tag {
          font-size: 10.5px;
          font-weight: 600;
          letter-spacing: .03em;
          text-transform: uppercase;
          color: var(--cobalt-600);
          background: var(--cobalt-50);
          border: 1px solid var(--cobalt-100);
          padding: 3px 8px;
          border-radius: 999px;
        }
        .blog-card-title {
          font-size: 17px;
          font-weight: 700;
          line-height: 1.32;
          color: var(--fg-0);
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .blog-card-desc {
          font-size: 14px;
          line-height: 1.55;
          color: var(--fg-2);
          margin: 0;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .blog-card-meta {
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 12.5px;
          color: var(--fg-3);
          margin-top: auto;
          padding-top: 6px;
        }
        .blog-card-author { color: var(--fg-1); font-weight: 600; }
        .blog-avatar { border-radius: 999px; display: block; }
        .blog-dot { color: var(--fg-4); }

        .blog-empty {
          text-align: center;
          color: var(--fg-3);
          font-size: 15px;
          padding: 40px 0;
        }
      `}</style>
    </div>
  );
}
