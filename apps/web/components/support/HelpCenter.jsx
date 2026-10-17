'use client';

import { useCallback, useEffect, useState } from 'react';
import { Btn } from '../Primitives';
import { articleLinkHref, SUPPORT_EMAIL } from '@/lib/support/help-links.mjs';
import HelpSearch from './HelpSearch';
import ContactForm from './ContactForm';

/**
 * The help center: search, the contact block, then the articles by category.
 * Rendered by the public /help page and by the dashboard's help section.
 *
 * Order is deliberate. Contacting us sits directly under the search, above
 * every article, so it is visible without scrolling: the email address as a
 * mailto, and a button that opens the form in place. Articles start collapsed
 * (`<details>`, title and one-line summary visible) and open on demand.
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
 *  - formFooter: rendered under the form (the staff preview links on /help)
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

function Article({ article, locale, onLinkClick }) {
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
  formFooter = null,
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
        {formFooter}
      </section>

      {categories.map((c) => (
        <section key={c.area} className="help-category" aria-labelledby={`help-cat-${c.area}`} data-area={c.area}>
          <h2 id={`help-cat-${c.area}`}>{c.title}</h2>
          {c.lead ? <p className="help-muted">{c.lead}</p> : null}
          {c.articles.map((a) => (
            <Article key={a.id} article={a} locale={locale} onLinkClick={onLinkClick} />
          ))}
        </section>
      ))}
    </div>
  );
}
