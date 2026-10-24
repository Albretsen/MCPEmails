import { cache } from 'react';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { getSupportViewer } from '@/lib/support/viewer';
import { issueSupportFormToken } from '@/lib/support/form-token';
import { getTicketContextPreview } from '@/lib/support/context';
import { getProvider } from '@/lib/connect/providers.mjs';
import {
  getHelpContent,
  fill,
  helpHref,
  SUPPORT_CATEGORIES,
  SUPPORT_EMAIL,
} from '@/lib/support/help-content.mjs';
import { getSearchIndex } from '@/lib/support/search-index.mjs';
import { Nav, Footer } from '../../../components/marketing/Sections';
import HelpSearch from '../../../components/support/HelpSearch';
import ContactForm from '../../../components/support/ContactForm';
import { requireLocale } from '@/i18n/require-locale';
import '../../../styles/help.css';

/**
 * /help: search over the existing guides, seven short troubleshooting
 * articles, and the contact form.
 *
 * The articles are sections on this page (anchors `#article-<id>`), not
 * sub-routes: seven short answers read better on one page a visitor can scan,
 * there is one gate and one noindex to remove at release instead of eight, and
 * the search links straight to the anchor.
 *
 * Dynamic by nature (it reads the session and the preview cookie), so no
 * generateStaticParams. Not in the sitemap.
 */

// One session read per request, shared by generateMetadata and the page.
const viewerForRequest = cache(getSupportViewer);

const SLUG_RE = /^[a-z0-9_.-]{1,64}$/;

/** First value of a search param, kept only when it is a plain slug. */
function slugParam(value) {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string') return null;
  const lower = v.trim().toLowerCase();
  return SLUG_RE.test(lower) ? lower : null;
}

/** The provider's display name for a slug from the connect modal, or null. */
function providerName(slug) {
  if (!slug) return null;
  const resolved = slug === 'generic' ? 'imap' : slug;
  return getProvider(resolved)?.name ?? null;
}

export async function generateMetadata({ params }) {
  const { locale } = await params;
  requireLocale(locale);
  const viewer = await viewerForRequest();
  // SUPPORT_RELEASE_GATE: noindex while internal-only. Remove at release.
  const robots = { index: false, follow: false };
  if (!viewer.visible) return { robots }; // SUPPORT_RELEASE_GATE
  const content = await getHelpContent(locale);
  return {
    title: content.meta.title,
    description: content.meta.description,
    robots, // SUPPORT_RELEASE_GATE
  };
}

export default async function HelpPage({ params, searchParams }) {
  const { locale } = await params;
  requireLocale(locale);
  setRequestLocale(locale);

  const viewer = await viewerForRequest();
  if (!viewer.visible) notFound(); // SUPPORT_RELEASE_GATE

  const sp = await searchParams;
  const topic = slugParam(sp?.topic);
  const provider = slugParam(sp?.provider);
  const code = slugParam(sp?.code);
  const from = slugParam(sp?.from);

  const content = await getHelpContent(locale);
  const [index, baseContext] = await Promise.all([
    getSearchIndex(locale, content),
    viewer.user ? getTicketContextPreview(viewer.user.id) : Promise.resolve(null),
  ]);
  const context = baseContext ? { ...baseContext, from, provider, code } : null;

  const name = providerName(provider);
  const initialCategory = topic && SUPPORT_CATEGORIES.includes(topic) ? topic : 'connect';
  const initialSubject = topic === 'connect' && name ? fill(content.form.subjectConnect, { provider: name }) : '';
  const formToken = issueSupportFormToken();

  const [emailBefore, emailAfter = ''] = content.contact.emailAlt.split('{email}');

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 24 }}>
        <div className="help-wrap">
          <div className="eye-label">{content.hero.eyebrow}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            {content.hero.title}
          </h1>
          <p className="pricing-page-lead">{content.hero.lead}</p>
          <HelpSearch index={index} copy={content.search} />
        </div>
      </section>

      <section className="help-section" aria-labelledby="help-articles">
        <div className="help-wrap">
          <h2 id="help-articles">{content.articlesHeading}</h2>
          <p className="help-muted">{content.articlesLead}</p>
          {content.articles.map((a) => (
            <article key={a.id} id={`article-${a.id}`} className="help-article">
              <h3>{a.title}</h3>
              <p>{a.summary}</p>
              <ol>
                {a.steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
              <div className="help-article-links">
                {a.links.map((l) => (
                  <a key={l.href} href={helpHref(locale, l.href)}>{l.label}</a>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="help-section" aria-labelledby="help-contact">
        <div className="help-wrap">
          <h2 id="help-contact">{content.contact.heading}</h2>
          <p className="help-muted">{content.contact.lead}</p>
          <p className="help-muted">
            {emailBefore}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            {emailAfter}
          </p>
          <ContactForm
            copy={content}
            signedInEmail={viewer.user?.email ?? null}
            context={context}
            formToken={formToken}
            initialCategory={initialCategory}
            initialSubject={initialSubject}
            providerName={name}
            meta={{ from, provider, code }}
            categories={SUPPORT_CATEGORIES}
          />
          {/* SUPPORT_RELEASE_GATE: staff-only preview of the signed-out form. Remove at release. */}
          {viewer.user ? (
            <p className="help-gate">
              <a href="/api/support/preview">{content.preview.link}</a> {content.preview.note}
            </p>
          ) : (
            <p className="help-gate">
              <a href="/api/support/preview?clear=1">{content.preview.clear}</a>
            </p>
          )}
        </div>
      </section>

      <Footer />
    </div>
  );
}
