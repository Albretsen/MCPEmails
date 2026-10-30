'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Btn } from '../Primitives';
import { articleLinkHref, SUPPORT_EMAIL } from '@/lib/support/help-links.mjs';
import HelpSearch from './HelpSearch';
import ContactForm from './ContactForm';

/**
 * The help center: search, the contact block, then the articles by category.
 * Rendered by the public /help page and by the dashboard's help section.
 *
 * Layout. A section list sits on the left (a row of links on narrow screens)
 * and jumps to the contact block and each category; the section in view is
 * marked. Contact comes first: the address and a button that opens the form
 * in place, so it is visible without scrolling. Articles start collapsed (`<details>`, title
 * and one-line summary visible), open on demand, and end with "Was this
 * helpful?" (POST /api/support/article-feedback, remembered per article in
 * this browser so the answer shows on the next visit).
 *
 * Opening from outside:
 *  - `#article-<id>` in the URL (on load and on every hash change) opens that
 *    article and scrolls to it;
 *  - picking an article in the search does the same without leaving the page;
 *  - `#contact` opens the form and scrolls to the contact block.
 *
 * Props:
 *  - variant: 'page' (marketing /help) or 'app' (inside the dashboard shell)
 *  - locale, copy (help-content without articles), categories, index
 *  - form: { signedInEmail, context, formToken, initialCategory,
 *    initialSubject, providerName, meta, open }
 *  - supportCategories: the ticket categories, in display order
 *  - onNavigate(href, event): called on a plain click of an article link; true
 *    means it was handled (the dashboard switches sections without a reload)
 */

const ARTICLE_PREFIX = 'article-';

function currentHash() {
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch {
    return '';
  }
}

function scrollTo(el) {
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' });
}

/** Opens the article's `<details>` and scrolls to it. False when there is no such article here. */
function openArticle(id) {
  const el = document.getElementById(`${ARTICLE_PREFIX}${id}`);
  if (!el || el.tagName !== 'DETAILS') return false;
  el.open = true;
  scrollTo(el);
  return true;
}

function splitOn(template, token) {
  const s = String(template ?? '');
  const at = s.indexOf(token);
  return at === -1 ? [s, ''] : [s.slice(0, at), s.slice(at + token.length)];
}

const VOTE_KEY = 'mcpe_help_vote:';

const noSubscribe = () => () => {};

function storedVote(id) {
  try {
    const v = window.localStorage.getItem(`${VOTE_KEY}${id}`);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

// A text button: "Change answer" sits in the thanks line, not as a second
// row of buttons.
const CHANGE_BUTTON = { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer' };

/**
 * "Was this helpful?" Yes / No. The answer is sent once per click and kept in
 * this browser. "Change answer" brings the buttons back; the server upserts,
 * so a second answer replaces the first.
 */
function ArticleFeedback({ articleId, locale, copy }) {
  // The server has no localStorage, so its snapshot is null and the stored
  // answer appears after hydration without a mismatch.
  const stored = useSyncExternalStore(noSubscribe, () => storedVote(articleId), () => null);
  const [clicked, setClicked] = useState(null);
  const [changing, setChanging] = useState(false);
  const vote = clicked ?? stored;

  const send = (answer) => {
    setClicked(answer);
    setChanging(false);
    try {
      window.localStorage.setItem(`${VOTE_KEY}${articleId}`, answer);
    } catch { /* the vote is still sent */ }
    fetch('/api/support/article-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ articleId, locale, helpful: answer === 'yes' }),
    }).catch(() => {});
  };

  if (vote && !changing) {
    return (
      <p className="help-feedback help-feedback-done">
        <span role="status">
          {vote === 'yes' ? copy.thanks : (
            <>
              {copy.thanksNo} <a href="#contact">{copy.contactLink}</a>
            </>
          )}
        </span>{' '}
        <button type="button" className="help-feedback-change" style={CHANGE_BUTTON} onClick={() => setChanging(true)}>
          {copy.change}
        </button>
      </p>
    );
  }
  return (
    <div className="help-feedback">
      <span>{copy.question}</span>
      <button type="button" className="help-feedback-btn" onClick={() => send('yes')}>{copy.yes}</button>
      <button type="button" className="help-feedback-btn" onClick={() => send('no')}>{copy.no}</button>
    </div>
  );
}

/**
 * The section list. Marks the last section whose heading has scrolled past a
 * line near the top of the viewport (the first section until then, the last
 * one once the page is scrolled to the end). Scroll events are caught in the
 * capture phase, so this works for the marketing page (window scrolls) and
 * the dashboard (`.page` scrolls) alike.
 */
function SectionNav({ sections, label }) {
  const [active, setActive] = useState(sections[0]?.id ?? null);

  useEffect(() => {
    let frame = 0;
    // The line sits a little below the top of whatever scrolls: the window on
    // /help, `.page` (under the top bar) in the dashboard. A jump puts a
    // heading scroll-margin-top (80px) below that top, so 120px clears it.
    const first = document.getElementById(sections[0]?.id);
    let scroller = first?.parentElement ?? null;
    while (scroller && scroller !== document.body) {
      const { overflowY } = window.getComputedStyle(scroller);
      if ((overflowY === 'auto' || overflowY === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    const scrollerTop = () => (scroller && scroller !== document.body ? scroller.getBoundingClientRect().top : 0);
    const update = () => {
      frame = 0;
      const line = scrollerTop() + 120;
      let current = sections[0]?.id ?? null;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      // Scrolled to the end: the last section may be too short to reach the line.
      const last = document.getElementById(sections[sections.length - 1]?.id);
      if (last && last.getBoundingClientRect().bottom <= window.innerHeight + 2) current = last.id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections]);

  return (
    <nav className="help-nav" aria-label={label}>
      <ul>
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className={s.id === active ? 'active' : undefined}
              aria-current={s.id === active ? 'location' : undefined}
              onClick={(e) => {
                const el = document.getElementById(s.id);
                if (!el || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                scrollTo(el);
                setActive(s.id);
                try {
                  window.history.replaceState(window.history.state, '', `#${s.id}`);
                } catch { /* scrolled either way */ }
              }}
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Article({ article, locale, onLinkClick, feedbackCopy }) {
  return (
    <details className="help-article" id={`${ARTICLE_PREFIX}${article.id}`}>
      <summary>
        <span className="help-article-title">{article.title}</span>
        <span className="help-article-summary">{article.summary}</span>
      </summary>
      <div className="help-article-body">
        {article.body.map((p, i) => <p key={i}>{p}</p>)}
        {article.steps.length > 0 ? (
          <ol>
            {article.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        ) : null}
        {article.links.length > 0 ? (
          <div className="help-article-links">
            {article.links.map((l) => {
              const href = articleLinkHref(locale, l.href);
              return (
                <a key={l.href} href={href} onClick={(e) => onLinkClick(href, e)}>{l.label}</a>
              );
            })}
          </div>
        ) : null}
        {feedbackCopy ? <ArticleFeedback articleId={article.id} locale={locale} copy={feedbackCopy} /> : null}
      </div>
    </details>
  );
}

export default function HelpCenter({
  variant = 'page',
  locale = 'en',
  copy,
  categories = [],
  index = [],
  form = {},
  supportCategories,
  onNavigate,
}) {
  const [formOpen, setFormOpen] = useState(Boolean(form.open));

  const applyHash = useCallback(() => {
    const hash = currentHash();
    if (hash === 'contact') {
      setFormOpen(true);
      scrollTo(document.getElementById('contact'));
    } else if (hash.startsWith(ARTICLE_PREFIX)) {
      openArticle(hash.slice(ARTICLE_PREFIX.length));
    }
  }, []);

  // The hash is read after the first paint, never during render: the server
  // cannot see it, so reading it earlier would make the first client render
  // differ from the server's HTML.
  useEffect(() => {
    const frame = window.requestAnimationFrame(applyHash);
    window.addEventListener('hashchange', applyHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', applyHash);
    };
  }, [applyHash]);

  // A search result for an article on this page opens it in place. The hash
  // is updated without a navigation, so the URL can be shared and reloads land
  // on the same article; history.state is kept for the Next.js router.
  const onSelect = useCallback((entry) => {
    if (entry?.kind !== 'article' || typeof entry.id !== 'string') return false;
    const id = entry.id.replace(/^article:/, '');
    if (!openArticle(id)) return false;
    try {
      window.history.replaceState(window.history.state, '', `#${ARTICLE_PREFIX}${id}`);
    } catch { /* the article is open either way */ }
    return true;
  }, []);

  const onLinkClick = useCallback((href, e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (onNavigate && onNavigate(href, e)) e.preventDefault();
  }, [onNavigate]);

  const contact = copy.contact ?? {};
  const [emailBefore, emailAfter] = splitOn(contact.emailLine, '{email}');
  const email = SUPPORT_EMAIL;
  const contactTitle = copy.nav?.contact ?? contact.heading;
  const sections = useMemo(() => [
    { id: 'contact', title: contactTitle },
    ...categories.map((c) => ({ id: `help-cat-${c.area}`, title: c.title })),
  ], [categories, contactTitle]);

  return (
    <div className={`help-center help-center-${variant}`}>
      <header className="help-head">
        {variant === 'page' ? (
          <>
            <div className="eye-label">{copy.hero.eyebrow}</div>
            <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>{copy.hero.title}</h1>
            <p className="pricing-page-lead">{copy.hero.lead}</p>
          </>
        ) : (
          <div className="page-header" style={{ padding: 0, margin: 0 }}>
            <div className="grow">
              <h1 className="page-title" style={{ margin: 0 }}>{copy.hero.title}</h1>
              <p className="page-sub" style={{ margin: '4px 0 0' }}>{copy.hero.lead}</p>
            </div>
          </div>
        )}
        <HelpSearch index={index} copy={copy.search} onSelect={onSelect} />
      </header>

      <div className="help-layout">
        <SectionNav sections={sections} label={copy.nav?.label ?? ''} />

        <div className="help-main">
          <section id="contact" className="help-contact help-contact-block" aria-labelledby="help-contact">
            <h2 id="help-contact">{contact.heading}</h2>
            <p className="help-muted">{contact.lead}</p>
            <p className="help-contact-email">
              {emailBefore}
              <a href={`mailto:${email}`}>{email}</a>
              {emailAfter}
            </p>
            {formOpen ? (
              <ContactForm
                copy={copy}
                signedInEmail={form.signedInEmail ?? null}
                context={form.context ?? null}
                formToken={form.formToken ?? ''}
                initialCategory={form.initialCategory ?? 'connect'}
                initialSubject={form.initialSubject ?? ''}
                providerName={form.providerName ?? null}
                meta={form.meta ?? {}}
                categories={supportCategories}
              />
            ) : (
              <div className="help-actions">
                <Btn variant="primary" onClick={() => setFormOpen(true)}>{contact.openForm}</Btn>
              </div>
            )}
          </section>

          {categories.map((c) => (
            <section key={c.area} id={`help-cat-${c.area}`} className="help-category" aria-labelledby={`help-cat-${c.area}-h`} data-area={c.area}>
              <h2 id={`help-cat-${c.area}-h`}>{c.title}</h2>
              {c.lead ? <p className="help-muted">{c.lead}</p> : null}
              {c.articles.map((a) => (
                <Article key={a.id} article={a} locale={locale} onLinkClick={onLinkClick} feedbackCopy={copy.feedback} />
              ))}
            </section>
          ))}

        </div>
      </div>
    </div>
  );
}
