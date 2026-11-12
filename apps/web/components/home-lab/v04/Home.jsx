/**
 * Homepage Lab v04: "The Correspondence Catalogue" (staging only, English).
 *
 * A short hero whose headline is the provider list, then the FAQ as the body
 * of the page in four chapters (Setup, Safety, Teams, Billing), the pricing
 * catalogue, and a closing letter. One colour: brand cobalt and its tints on
 * white, screenshots duotoned through an SVG filter. Server component; the
 * only client islands are the price plates and the euro swap in FAQ answers
 * (both for EU currency). The client tabs are CSS-only radio tabs.
 */

import { Fragment } from 'react';
import Plates from './Plates';
import Money from './Money';
import { REVIEWS } from '../../marketing/reviews.mjs';
import {
  MCP_URL, nav, hero, contents, whatIs, setup, safety, teams, billing, pricing, closing, footer, FAQ_CHAPTER,
} from './copy.mjs';
import { CHOICES } from './rng.mjs';
import s from './Home.module.css';

/** The LCP font (H1 and lead), resolved to the bundler's hashed asset URL. */
const CASLON_400 = new URL('./fonts/libre-caslon-text-400.woff2', import.meta.url);
const A = '/home-lab/assets/a/';
const C = '/home-lab/assets/c/';

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(4));
}

/** Tritone map: shadows to deep cobalt, mid-tones to cobalt-500, highlights to paper. */
function DuotoneFilter() {
  const [r0, g0, b0] = hex(CHOICES.duoShadow);
  const [r1, g1, b1] = hex('#2547E5');
  return (
    <svg className={s.filterDefs} width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="v04-duo" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={`${r0} ${r1} 1`} />
          <feFuncG type="table" tableValues={`${g0} ${g1} 1`} />
          <feFuncB type="table" tableValues={`${b0} ${b1} 1`} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}

function Shot({ name, alt, width, height, mobile, className, imgClassName }) {
  return (
    <picture className={className}>
      {mobile ? (
        <>
          <source media="(max-width: 640px)" type="image/avif" srcSet={`${A}${mobile.name}.avif`} width={mobile.width} height={mobile.height} />
          <source media="(max-width: 640px)" type="image/webp" srcSet={`${A}${mobile.name}.webp`} width={mobile.width} height={mobile.height} />
        </>
      ) : null}
      <source type="image/avif" srcSet={`${A}${name}.avif`} />
      <img
        className={imgClassName}
        src={`${A}${name}.webp`}
        alt={alt}
        width={width}
        height={height}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

function groupFaq(items) {
  const groups = { setup: [], safety: [], teams: [], billing: [] };
  items.forEach((item, i) => {
    const key = FAQ_CHAPTER[item.q] ?? 'billing';
    groups[key].push({ ...item, n: i + 1 });
  });
  return groups;
}

function QA({ items, title, eurEnabled, locale, id }) {
  if (!items.length) return null;
  return (
    <div className={s.qaBlock}>
      <p className={s.qaLabel} id={id}>{title}</p>
      <div className={s.qaList} role="list" aria-labelledby={id}>
        {items.map((item) => (
          <article key={item.q} className={s.qa} role="listitem">
            <h3 className={s.q}>
              <span className={s.qn} aria-hidden="true">Q.{item.n}</span>
              {item.q}
            </h3>
            <p className={s.a}>
              {item.a.includes('$') ? <Money text={item.a} eurEnabled={eurEnabled} locale={locale} /> : item.a}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}

function ChapterHead({ numeral, kicker, title, id, children }) {
  return (
    <header className={s.chapterHead}>
      <span className={s.chapterNum} aria-hidden="true">{numeral}</span>
      <div>
        <p className={s.kicker}>{kicker}</p>
        <h2 id={id} className={s.h2}>{title}</h2>
        {children}
      </div>
    </header>
  );
}

function LinkRow({ links, className }) {
  return (
    <ul className={`${s.linkRow} ${className ?? ''}`}>
      {links.map((l) => (
        <li key={l.href}>
          <a href={l.href}>{l.label}</a>
        </li>
      ))}
    </ul>
  );
}

function ClientTabs() {
  const d = CHOICES.defaultTab;
  return (
    <div className={s.tabs} style={{ '--tabs': setup.clients.length }}>
      {setup.clients.map((c, i) => (
        <input
          key={c.slug}
          type="radio"
          name="v04-client"
          id={`v04-tab-${c.slug}`}
          className={`${s.tabInput} ${s[`t${i}`]}`}
          defaultChecked={i === d}
          aria-label={`Show setup for ${c.name}`}
        />
      ))}
      <div className={s.tabList}>
        {setup.clients.map((c, i) => (
          <label key={c.slug} htmlFor={`v04-tab-${c.slug}`} className={`${s.tabLabel} ${s[`l${i}`]}`}>
            {c.name}
          </label>
        ))}
        <span className={s.underline} aria-hidden="true" />
      </div>
      <div className={s.panels}>
        {setup.clients.map((c, i) => (
          <div key={c.slug} className={`${s.panel} ${s[`p${i}`]}`}>
            <dl className={s.letterSmall}>
              <div><dt>Client</dt><dd>{c.name}</dd></div>
              <div><dt>URL</dt><dd>{MCP_URL}</dd></div>
              {c.file ? <div><dt>File</dt><dd>{c.file}</dd></div> : null}
            </dl>
            <p>{c.steps}</p>
            <a className={s.textLink} href={`/docs/clients/${c.slug}`}>
              Full {c.name} setup guide
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

function Review() {
  const r = REVIEWS[0];
  if (!r) return null;
  const at = r.pullQuote ? r.quote.indexOf(r.pullQuote) : -1;
  const body =
    at >= 0 ? (
      <>
        {r.quote.slice(0, at)}
        <strong>{r.pullQuote}</strong>
        {r.quote.slice(at + r.pullQuote.length)}
      </>
    ) : (
      r.quote
    );
  return (
    <figure className={s.review}>
      <blockquote className={s.reviewQuote}>
        <p>“{body}”</p>
      </blockquote>
      <figcaption className={s.reviewBy}>
        <span>{r.author}</span>
        <span>
          {r.role}, {r.url ? <a href={r.url}>{r.company}</a> : r.company}
        </span>
        <span>
          {teams.reviewRating}.{' '}
          {r.sourceUrl ? <a href={r.sourceUrl}>{teams.reviewVia}</a> : teams.reviewVia}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * @param {{
 *   stripePrices?: any,
 *   eurEnabled?: boolean,
 *   businessSeat?: any,
 *   faqItems?: { q: string, a: string }[],
 *   locale?: string,
 * }} props
 */
export default function Home({ stripePrices, eurEnabled = false, businessSeat = null, faqItems = [], locale = 'en' }) {
  const faq = groupFaq(Array.isArray(faqItems) ? faqItems : []);
  const tintClass = CHOICES.tint === 'c50' ? s.tint50 : s.tint100;

  return (
    <div className={s.page}>
      {/* First child of the body so the hint is in the HTML before the H1:
          the provider-list H1 and the lead paint in Caslon 400. Same hashed
          URL as the @font-face in Home.module.css. */}
      <link rel="preload" href={CASLON_400.href} as="font" type="font/woff2" crossOrigin="anonymous" />
      <DuotoneFilter />
      <a className={s.skip} href="#v04-main">Skip to content</a>

      <header className={s.header}>
        <div className={s.wrap}>
          <div className={s.headerRow}>
            <a href="/" className={s.logo}>
              <img src="/logo-wordmark.svg" alt="MCPEmails" width="280" height="48" />
            </a>
            <nav className={s.nav} aria-label="Primary">
              <ul>
                {nav.map((n) => (
                  <li key={n.href}><a href={n.href}>{n.label}</a></li>
                ))}
              </ul>
            </nav>
            <div className={s.headerActions}>
              <a href="/login" className={s.signIn}>Sign in</a>
              <a href="/signup" className={s.btnPrimarySmall}>Start free</a>
            </div>
          </div>
        </div>
      </header>

      <main id="v04-main">
        {/* HERO: the provider list is the headline */}
        <section className={s.hero} aria-labelledby="v04-h1">
          <div className={s.wrap}>
            <dl className={s.letter}>
              {hero.letter.map((l) => (
                <div key={l.k}>
                  <dt>{l.k}:</dt>
                  <dd>{l.v}</dd>
                </div>
              ))}
            </dl>
            <h1 id="v04-h1" className={s.h1}>
              {hero.providers.map((p, i) => (
                <Fragment key={p.word}>
                  <span className={s.h1Word}>
                    <a href={p.href} className={i === CHOICES.italicWord ? s.h1Marked : undefined}>{p.word}</a>.
                  </span>{' '}
                </Fragment>
              ))}
            </h1>
            <div className={s.heroBody}>
              <p className={s.lead}>{hero.lead}</p>
              <div>
                <p className={s.heroBusiness}>
                  {hero.business}{' '}
                  <a href="/for/business">{hero.businessLink}</a>.
                </p>
                <div className={s.ctaRow}>
                  <a className={s.btnPrimary} href="/signup">{hero.ctaPrimary}</a>
                  <a className={s.btnSecondary} href="/connect">{hero.ctaSecondary}</a>
                </div>
                <p className={s.mono}>{hero.footnote}</p>
              </div>
            </div>
          </div>
        </section>

        {/* CONTENTS */}
        <nav className={s.contents} aria-label={contents.label}>
          <div className={s.wrap}>
            <p className={s.contentsLabel}>{contents.label}</p>
            <ol>
              {contents.items.map((c) => (
                <li key={c.href}>
                  <a href={c.href}>
                    <span className={s.contentsNum}>{c.n}</span>
                    <span className={s.contentsTitle}>{c.title}</span>
                    <span className={s.contentsSub}>{c.sub}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>

        {/* WHAT IS */}
        <section id="features" className={s.section} aria-labelledby="v04-what">
          <div className={`${s.wrap} ${s.whatGrid}`}>
            <div>
              <p className={s.kicker}>{whatIs.kicker}</p>
              <h2 id="v04-what" className={s.h2}>{whatIs.title}</h2>
            </div>
            <div className={s.prose}>
              <p className={s.mission}>{whatIs.mission}</p>
              <p>{whatIs.p1}</p>
              <p>{whatIs.p2}</p>
              <p>{whatIs.p3}</p>
              <LinkRow links={whatIs.links} />
            </div>
          </div>
        </section>

        {/* CHAPTER I: SETUP */}
        <section id="setup" className={s.chapter} aria-labelledby="v04-setup">
          <div id="how" className={s.anchor} />
          <div className={s.wrap}>
            <ChapterHead numeral={setup.numeral} kicker={setup.kicker} title={setup.title} id="v04-setup">
              <p className={s.chapterLead}>{setup.lead}</p>
            </ChapterHead>

            <div className={s.block}>
              <h3 className={s.h3}>{setup.stepsTitle}</h3>
              <ol className={s.steps}>
                {setup.steps.map((st, i) => (
                  <li key={st.h} className={s.step}>
                    <span className={s.stepNum} aria-hidden="true">{i + 1}</span>
                    <h4 className={s.h4}>{st.h}</h4>
                    <p className={s.memo}>{st.memo}</p>
                    <p>{st.p}</p>
                  </li>
                ))}
              </ol>
            </div>

            <div className={`${s.block} ${s.split}`}>
              <div>
                <h3 className={s.h3}>{setup.clientsTitle}</h3>
                <p className={s.blockLead}>{setup.clientsLead}</p>
                <a className={s.textLink} href="/docs/clients">{setup.clientsMore}</a>
              </div>
              <ClientTabs />
            </div>

            <div className={`${s.block} ${s.split}`}>
              <div>
                <h3 className={s.h3}>{setup.cardTitle}</h3>
                <p className={s.blockLead}>{setup.cardP}</p>
              </div>
              <Shot
                name="card-draft-light-desktop"
                mobile={{ name: 'card-draft-light-mobile', width: 720, height: 878 }}
                alt={setup.cardAlt}
                width={1364}
                height={776}
                className={s.frame}
                imgClassName={s.duo}
              />
            </div>

            <div className={s.block}>
              <h3 className={s.h3}>{setup.providersTitle}</h3>
              <p className={s.blockLead}>{setup.providersLead}</p>
              <picture className={s.wall}>
                <source media="(max-width: 640px)" srcSet={`${C}logo-wall-mono-mobile.svg`} width={358} height={620} />
                <img
                  className={s.duo}
                  src={`${C}logo-wall-mono.svg`}
                  alt={setup.providersAlt}
                  width={960}
                  height={240}
                  loading="lazy"
                  decoding="async"
                />
              </picture>
              <ul className={s.providerList}>
                {setup.providerList.map((p) => (
                  <li key={p.href}>
                    <a href={p.href}>{p.name}</a>
                    <span>{p.how}</span>
                  </li>
                ))}
              </ul>
              <p className={s.linksLine}>
                <a className={s.textLink} href="/connect">{setup.providersAll}</a>
                <a className={s.textLink} href="/tools/email-settings-lookup">{setup.lookup}</a>
              </p>
            </div>

            <div className={s.block}>
              <h3 className={s.h3}>{setup.examplesTitle}</h3>
              <ul className={s.examples}>
                {setup.examples.map((e) => (
                  <li key={e.prompt}>
                    <p className={s.examplePrompt}>{e.prompt}</p>
                    <p className={s.exampleNote}>{e.note}</p>
                  </li>
                ))}
              </ul>
            </div>

            <QA items={faq.setup} title={setup.faqTitle} eurEnabled={eurEnabled} locale={locale} id="v04-qa-setup" />
          </div>
        </section>

        {/* CHAPTER II: SAFETY, the ink band */}
        <section id="safety" className={s.ink} aria-labelledby="v04-safety">
          <div className={s.wrap}>
            <ChapterHead numeral={safety.numeral} kicker={safety.kicker} title={safety.title} id="v04-safety">
              <p className={s.missionInk}>{safety.mission}</p>
              <p className={s.chapterLead}>{safety.lead}</p>
            </ChapterHead>

            <div className={s.block}>
              <h3 className={s.h3}>{safety.ledgerTitle}</h3>
              <ol className={s.ledger}>
                {safety.ledger.map((l, i) => (
                  <li key={l.h}>
                    <span className={s.ledgerNum} aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                    <h4 className={s.h4}>{l.h}</h4>
                    <p>{l.p}</p>
                  </li>
                ))}
              </ol>
              <div className={s.storedFrame}>
                <img
                  className={s.duo}
                  src={`${C}diagram-stored.svg`}
                  alt={safety.storedAlt}
                  width={960}
                  height={400}
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </div>

            <div className={`${s.block} ${s.revoke}`}>
              <h3 className={s.h3}>{safety.revokeTitle}</h3>
              <div className={s.revokeShot}>
                <picture>
                  <source type="image/avif" srcSet={`${A}dashboard-inboxes-light-desktop.avif`} />
                  <img
                    className={s.duo}
                    src={`${A}dashboard-inboxes-light-desktop.webp`}
                    alt={safety.revokeAlt}
                    width={2880}
                    height={1800}
                    loading="lazy"
                    decoding="async"
                  />
                </picture>
                <span className={`${s.pin} ${s.revokePin}`} aria-hidden="true">1</span>
              </div>
              <p className={s.revokeLine}>
                <span className={s.pinInline} aria-hidden="true">1</span>
                {safety.revokeLine}
              </p>
              <p className={s.revokeNote}>{safety.revokeNote}</p>
              <LinkRow links={safety.links} className={s.linkRowInk} />
            </div>

            <QA items={faq.safety} title={safety.faqTitle} eurEnabled={eurEnabled} locale={locale} id="v04-qa-safety" />
          </div>
        </section>

        {/* CHAPTER III: TEAMS */}
        <section id="teams" className={s.chapter} aria-labelledby="v04-teams">
          <div className={s.wrap}>
            <ChapterHead numeral={teams.numeral} kicker={teams.kicker} title={teams.title} id="v04-teams">
              <p className={s.chapterLead}>{teams.lead}</p>
            </ChapterHead>

            <div className={`${s.block} ${s.split}`}>
              <dl className={s.addresses}>
                {teams.addresses.map((a) => (
                  <div key={a.v}>
                    <dt>{a.k}:</dt>
                    <dd>
                      <span className={s.addr}>{a.v}</span>
                      <span className={s.addrNote}>{a.note}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <div className={s.prose}>
                <p>{teams.p1}</p>
                <p>{teams.p2}</p>
                <h3 className={s.h3}>{teams.seatTitle}</h3>
                {businessSeat ? (
                  <>
                    <p><Money text={businessSeat.card.desc} eurEnabled={eurEnabled} locale={locale} /></p>
                    <p>{businessSeat.card.minimum}</p>
                  </>
                ) : (
                  <p><Money text={teams.seatFallback} eurEnabled={eurEnabled} locale={locale} /></p>
                )}
                <LinkRow links={teams.links} />
              </div>
            </div>

            <div className={`${s.block} ${tintClass} ${s.dashBlock}`}>
              <h3 className={s.h3}>{teams.dashTitle}</h3>
              <p className={s.blockLead}>{teams.dashLead}</p>
              <div className={s.dash}>
                <Shot
                  name="dashboard-overview-light-desktop"
                  alt={teams.dashAlt}
                  width={2880}
                  height={1800}
                  imgClassName={s.duo}
                />
                {teams.pins.map((p, i) => (
                  <span key={p.h} className={s.pin} style={{ left: `${p.x}%`, top: `${p.y}%` }} aria-hidden="true">
                    {i + 1}
                  </span>
                ))}
              </div>
              <ol className={s.legend}>
                {teams.pins.map((p, i) => (
                  <li key={p.h}>
                    <span className={s.pinInline} aria-hidden="true">{i + 1}</span>
                    <span>
                      <strong>{p.h}.</strong> {p.p}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className={s.block}>
              <h3 className={s.h3}>{teams.reviewTitle}</h3>
              <Review />
            </div>

            <QA items={faq.teams} title={teams.faqTitle} eurEnabled={eurEnabled} locale={locale} id="v04-qa-teams" />
          </div>
        </section>

        {/* CHAPTER IV: BILLING */}
        <section id="billing" className={s.chapter} aria-labelledby="v04-billing">
          <div className={s.wrap}>
            <ChapterHead numeral={billing.numeral} kicker={billing.kicker} title={billing.title} id="v04-billing">
              <p className={s.chapterLead}>{billing.lead}</p>
            </ChapterHead>
            <QA items={faq.billing} title={billing.faqTitle} eurEnabled={eurEnabled} locale={locale} id="v04-qa-billing" />
          </div>
        </section>

        {/* PRICING CATALOGUE */}
        <section id="pricing" className={`${s.section} ${s.catalogue}`} aria-labelledby="v04-pricing">
          <div className={s.wrap}>
            <p className={s.kicker}>{pricing.kicker}</p>
            <h2 id="v04-pricing" className={s.h2}>{pricing.title}</h2>
            <p className={s.chapterLead}>
              {pricing.lead}
            </p>
            <Plates stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} locale={locale} />
            <p className={s.footnote}>
              {pricing.footnote} <a href="/pricing">{pricing.compare}</a>.{' '}
              <a href="mailto:hello@mcpemails.com">{pricing.contact}</a>.{' '}
              <a href="/for/business">{pricing.businessLink}</a>.
            </p>
          </div>
        </section>

        {/* CLOSING LETTER */}
        <section id="start" className={s.closing} aria-labelledby="v04-start">
          <div className={s.wrap}>
            <p className={s.kicker}>{closing.kicker}</p>
            <h2 id="v04-start" className={s.h2Big}>{closing.title}</h2>
            <div className={s.closingBody}>
              <p className={s.chapterLead}>{closing.p}</p>
              <div>
                <p className={s.signoff}>{closing.signoff}<br /><span>{closing.sign}</span></p>
                <dl className={s.letterSmall}>
                  <div><dt>{closing.endpointLabel}</dt><dd>{MCP_URL}</dd></div>
                </dl>
                <div className={s.ctaRow}>
                  <a className={s.btnPrimary} href="/signup">{closing.ctaPrimary}</a>
                  <a className={s.btnSecondary} href="/connect">{closing.ctaSecondary}</a>
                </div>
                <a className={s.textLink} href="/docs/clients">{closing.ctaTertiary}</a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className={s.footer}>
        <div className={s.wrap}>
          <div className={s.footerGrid}>
            <div className={s.footerBrand}>
              <a href="/" className={s.logo}>
                <img src="/logo-wordmark.svg" alt="MCPEmails" width="280" height="48" loading="lazy" />
              </a>
              <p>{footer.tagline}</p>
              <dl className={s.letterSmall}>
                <div><dt>{footer.contactLabel}</dt><dd><a href={`mailto:${footer.contact}`}>{footer.contact}</a></dd></div>
                <div><dt>{footer.endpointLabel}</dt><dd>{MCP_URL}</dd></div>
              </dl>
              <nav aria-label={footer.languageLabel} className={s.langs}>
                <p className={s.footerHeading}>{footer.languageLabel}</p>
                <ul>
                  {footer.languages.map(([href, lang, label]) => (
                    <li key={href}><a href={href} hrefLang={lang} lang={lang}>{label}</a></li>
                  ))}
                </ul>
              </nav>
            </div>
            {footer.columns.map((col) => (
              <div key={col.h}>
                <p className={s.footerHeading}>{col.h}</p>
                <ul className={s.footerLinks}>
                  {col.links.map(([href, label]) => (
                    <li key={href}><a href={href}>{label}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className={s.legal}>
            <span>{footer.copyright}</span>
            <span>{footer.legal}</span>
          </div>
          <p className={s.legalEntity}>{footer.legalEntity}</p>
        </div>
      </footer>
    </div>
  );
}
