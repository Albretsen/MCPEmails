import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Nav, Footer } from './Sections';
import { MIcon } from '../MarketingPrimitives';
import RichText from './RichText';
import { relatedProviders } from '@/lib/connect/release.mjs';
import { OAUTH_VERIFICATION_PENDING } from '@/lib/oauth/verification-status';

/**
 * A provider landing page, rendered on the server.
 *
 * This used to be a client component, for no reason: it has no state, no
 * effects and no handlers. That mattered once there were more than a handful of
 * providers, because `'use client'` here is what forced the copy to live in a
 * next-intl namespace, and the root layout serialises every namespace into
 * every marketing page. Rendering on the server lets the copy stay in
 * src/lib/connect/content, where only this page loads it. Nav and Footer are
 * still client components; they are the only things on the page that hydrate.
 */
export default async function ConnectProviderView({ locale, provider, content }) {
  const t = await getTranslations({ locale, namespace: 'connect' });
  const related = relatedProviders(provider.slug);
  const showGmailVerification = provider.slug === 'gmail' && OAUTH_VERIFICATION_PENDING;
  const ev = provider.evidence;

  return (
    <div>
      <Nav />

      <section className="pricing-page-hero">
        <div className="container">
          <div className="eye-label">{content.hero.eyebrow}</div>
          <h1 className="pricing-page-h1">
            {content.hero.titleLine1}<br />{content.hero.titleLine2}
          </h1>
          <p className="pricing-page-lead">{content.hero.lead}</p>
          {/*
            Direct answer to the question the query actually asks. These pages
            ranked between 4.7 and 9.2 and returned zero clicks: the snippet had
            nothing quotable to pull.
          */}
          {content.hero.answer && (
            <p className="pricing-page-answer">{content.hero.answer}</p>
          )}
          <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 24 }}>
            <a className="btn btn-primary btn-lg" href="/signup">
              {t('cta.primary', { provider: provider.name })}
            </a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{t('cta.secondary')}</Link>
          </div>
          <div className="hero-meta" style={{ justifyContent: 'center' }}>
            {['meta0', 'meta1', 'meta2'].map((k) => content.hero[k] && (
              <span className="item" key={k}>
                <MIcon name="check" size={14} color="var(--mint-600)" /> {content.hero[k]}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 56, paddingBottom: 0 }}>
        <div className="container">
          <div className="connect-callout">
            <MIcon name="lock" size={20} color="var(--cobalt-600)" />
            <div>
              <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>{content.method.title}</h2>
              <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 14, lineHeight: 1.6 }}>
                <RichText>{content.method.body}</RichText>
              </p>
            </div>
          </div>

          {showGmailVerification && (
            <div role="note" className="connect-callout connect-callout-warn">
              <MIcon name="alert-triangle" size={18} color="var(--amber-700)" />
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--amber-700)' }}>
                  {t('verificationNote.title')}
                </h3>
                <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 13.5, lineHeight: 1.6 }}>
                  <RichText>{t('verificationNote.body')}</RichText>
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/*
        The exact endpoints. Generic IMAP succeeds only about a quarter of the
        time and the recorded failures are people guessing at a port, so the
        four values the connect form asks for are the most directly useful
        thing on the page. The verification line under it is the part no
        competing page has: these hosts were not copied from a directory, they
        answered a TLS handshake under exactly this name on that date.
      */}
      {provider.imap && provider.smtp && (
        <section className="section" style={{ paddingTop: 40, paddingBottom: 0 }}>
          <div className="container">
            <h2 className="providers-h2">{t('settings.title', { provider: provider.name })}</h2>
            <p className="providers-sub">{t('settings.sub')}</p>
            <div className="comparison-wrap">
              <table className="comparison-tbl providers-conn-tbl">
                <thead>
                  <tr>
                    <th className="feat-col" style={{ minWidth: 150 }}>{t('settings.colProtocol')}</th>
                    <th style={{ minWidth: 200 }}>{t('settings.colHost')}</th>
                    <th style={{ minWidth: 110 }}>{t('settings.colPort')}</th>
                    <th style={{ minWidth: 140 }}>{t('settings.colSecurity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {['imap', 'smtp'].map((protocol) => (
                    <tr key={protocol}>
                      <td className="feat-name">{t(`settings.${protocol}`)}</td>
                      <td className="tbl-val">
                        <code className="connect-host">{provider[protocol].host}</code>
                      </td>
                      <td className="tbl-val" style={{ fontSize: 13 }}>{provider[protocol].port}</td>
                      <td className="tbl-val" style={{ fontSize: 13 }}>
                        {t(`settings.security.${provider[protocol].security}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="connect-verified">
              <MIcon name="check" size={13} color="var(--mint-600)" />{' '}
              {t('settings.verified', { date: ev.verifiedOn, host: provider.imap.host })}
              {ev.authMechs?.length > 0 &&
                ` ${t('settings.mechs', { mechs: ev.authMechs.join(', ') })}`}
            </p>
            {content.auth?.usernameForm && (
              <p className="connect-verified">
                <MIcon name="user" size={13} color="var(--fg-3)" />{' '}
                {t('settings.username')} {content.auth.usernameForm}
              </p>
            )}
          </div>
        </section>
      )}

      <section className="section principles">
        <div className="container">
          <div className="section-head principles-head">
            <div className="eye-label">{t('caps.eyebrow')}</div>
            <h2>{t('caps.title', { provider: provider.name })}</h2>
            <p className="sub">{t('caps.sub', { provider: provider.name })}</p>
          </div>
          <ol className="principle-list">
            {t.raw('capabilities').map((c, i) => (
              <li className="principle" key={i}>
                <div className="p-num">
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span className="t">{c.tag}</span>
                </div>
                <div className="p-body">
                  <h3>{c.h}</h3>
                  <p>{c.p}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section how" id="how" style={{ background: 'var(--bg-page)' }}>
        <div className="container">
          <div className="section-head">
            <div className="eye-label">{t('how.eyebrow')}</div>
            <h2>{t('how.title', { provider: provider.name })}</h2>
            <p className="sub">{t('how.sub')}</p>
          </div>
          <div className="how-steps">
            {content.setup.map((s, i) => (
              <div className="step" key={i}>
                <span className="num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{s.h}</h3>
                <p><RichText>{s.p}</RichText></p>
              </div>
            ))}
          </div>
          {/*
            Exact-match link to the long-form guide for this provider. The
            product page and the guide used to compete for the same query and
            neither ranked; the guide now owns the instructional phrase and this
            link is what tells Google they are a pair rather than duplicates.
          */}
          {content.guide?.href && (
            <p className="how-guide-link">
              {content.guide.intro}{' '}
              <Link href={content.guide.href}>{content.guide.label}</Link>
            </p>
          )}
          <p className="how-guide-link">
            {t('matrix.intro')} <Link href="/docs/providers">{t('matrix.label')}</Link>
          </p>
        </div>
      </section>

      {/*
        The part of the page that only we can write: what goes wrong with this
        specific provider, from the connection failures the product actually
        recorded. Every competing provider page is the same page with the name
        swapped; this section is why these are not.
      */}
      {content.gotchas?.length > 0 && (
        <section className="section" id="gotchas">
          <div className="container">
            <div className="section-head">
              <div className="eye-label">{t('gotchas.eyebrow')}</div>
              <h2>{t('gotchas.title', { provider: provider.name })}</h2>
            </div>
            <div className="connect-gotchas">
              {content.gotchas.map((g, i) => (
                <div className="connect-gotcha" key={i}>
                  <MIcon name="alert-triangle" size={17} color="var(--amber-700)" />
                  <div>
                    <h3>{g.h}</h3>
                    <p><RichText>{g.p}</RichText></p>
                  </div>
                </div>
              ))}
            </div>
            {content.limits?.length > 0 && (
              <div className="connect-limits">
                <h3>{t('limits.title', { provider: provider.name })}</h3>
                <ul>
                  {content.limits.map((l, i) => (
                    <li key={i}><RichText>{l}</RichText></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {content.faq?.length > 0 && (
        <section className="section" id="faq" style={{ background: 'var(--bg-page)' }}>
          <div className="container">
            <div className="section-head">
              <div className="eye-label">{t('faq.eyebrow')}</div>
              <h2>{t('faq.title', { provider: provider.name })}</h2>
            </div>
            <div className="connect-faq">
              {content.faq.map((f, i) => (
                <details className="connect-faq-item" key={i} open={i === 0}>
                  <summary><h3>{f.q}</h3></summary>
                  <p><RichText>{f.a}</RichText></p>
                </details>
              ))}
            </div>
          </div>
        </section>
      )}

      {/*
        Sibling links. With this site's backlink profile a page reachable only
        from the sitemap is a page that does not get crawled often enough to
        rank, so every provider page seeds the next six in its silo.
      */}
      {related.length > 0 && (
        <section className="section" id="related">
          <div className="container">
            <div className="section-head">
              <h2>{t('related.title')}</h2>
              <p className="sub">{t('related.sub')}</p>
            </div>
            <ul className="connect-related">
              {related.map((p) => (
                <li key={p.slug}>
                  <Link href={`/connect/${p.slug}`}>
                    {t('related.link', { provider: p.name })}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="how-guide-link">
              <Link href="/connect">{t('related.all')}</Link>
            </p>
          </div>
        </section>
      )}

      <section className="section cta-band">
        <div className="container">
          <h2>{content.ctaBand.title}</h2>
          <p className="sub">{content.ctaBand.sub}</p>
          <div className="hero-cta" style={{ justifyContent: 'center' }}>
            <a className="btn btn-primary btn-lg" href="/signup">
              {t('cta.primary', { provider: provider.name })}
            </a>
            <Link className="btn btn-secondary btn-lg" href="/docs">{t('cta.secondary')}</Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
