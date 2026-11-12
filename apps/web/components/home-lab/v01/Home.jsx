/**
 * Homepage Lab v01, "Catalogue" (staging only, English only).
 *
 * A server component: every word is in the HTML. The only client code is
 * three small islands: the hero clip (LoopClip), the hover clips (HoverClip)
 * and EUR display for EU visitors (Money). See README.md for the brief map.
 */
import {
  PLANS as CATALOGUE,
  planDisplayName,
  BUSINESS_EXTRA_INBOX_MONTHLY_CENTS,
  BUSINESS_INCLUDED_INBOXES,
  BUSINESS_MIN_SEATS,
  BUSINESS_PRIVATE_INBOXES_PER_PERSON,
} from '@/lib/stripe/plans';
import { pricingUpgradeHref } from '@/lib/billing/upgrade-intent.mjs';
import { withReadingLang } from '@/i18n/reading-lang.mjs';
import { formatUsdCopy } from '@/lib/stripe/annual-offer';
import { REVIEWS as REVIEW_LIST, REVIEW_SOURCES } from '../../marketing/reviews.mjs';
import {
  FOOTNOTES, NAV, HERO, SAMPLE, SPEC, BELIEFS, CONNECT, ASK, APPROVE, SECURITY, PROVIDERS,
  REVIEWS, TEAMS, PLANS, FAQ, FOOTNOTES_SECTION, CLOSING, FOOTER, MCP_URL,
} from './copy.mjs';
import { CHOICES, numeral } from './seed.mjs';
import LoopClip from './LoopClip';
import HoverClip from './HoverClip';
import { Price, MoneyText } from './Money';
import s from './Home.module.css';

const A = '/home-lab/assets/a';
// The H1 is the LCP element and paints in this face: preload it from the HTML.
const H1_FONT = new URL('./fonts/newsreader-500-italic.woff2', import.meta.url);
const C = '/home-lab/assets/c';
const cx = (...names) => names.filter(Boolean).join(' ');

/* ---------- inline markup: [[footnote]] and `code` ---------- */

const FN_INDEX = Object.fromEntries(FOOTNOTES.map((f, i) => [f.key, i + 1]));

function Fn({ k }) {
  const n = FN_INDEX[k];
  const note = FOOTNOTES[n - 1];
  if (!note) return null;
  return (
    <sup className={s.fn}>
      <a href={note.href} aria-label={`Source ${n}: ${note.source}`}>{n}</a>
    </sup>
  );
}

function rich(text) {
  return text.split(/(\[\[\w+\]\]|`[^`]+`)/g).map((part, i) => {
    if (!part) return null;
    const fn = /^\[\[(\w+)\]\]$/.exec(part);
    if (fn) return <Fn key={i} k={fn[1]} />;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i} className={s.code}>{part.slice(1, -1)}</code>;
    return part;
  });
}

/* ---------- media ---------- */

/** A product still with AVIF and WebP, desktop and (optionally) phone crops. Always lazy: none sit above the fold. */
function Still({ name, desk, mob, alt, className }) {
  return (
    <picture>
      {mob && <source media="(max-width: 767px)" type="image/avif" srcSet={`${A}/${name}-light-mobile.avif`} width={mob[0]} height={mob[1]} />}
      {mob && <source media="(max-width: 767px)" type="image/webp" srcSet={`${A}/${name}-light-mobile.webp`} width={mob[0]} height={mob[1]} />}
      <source type="image/avif" srcSet={`${A}/${name}-light-desktop.avif`} width={desk[0]} height={desk[1]} />
      <img
        className={cx(s.still, className)}
        src={`${A}/${name}-light-desktop.webp`}
        width={desk[0]}
        height={desk[1]}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

function Figure({ n, caption, children, className }) {
  const cap = (
    <figcaption className={s.caption}>
      <span className={s.figNo}>{n}</span> {rich(caption)}
    </figcaption>
  );
  return (
    <figure className={cx(s.figure, className)}>
      {CHOICES.captionSide === 'above' && cap}
      {children}
      {CHOICES.captionSide !== 'above' && cap}
    </figure>
  );
}

function SectionHead({ n, label, h2, sub, id }) {
  return (
    <div className={cx(s.head, CHOICES.sectionRule === 'double' ? s.headDouble : s.headSingle)}>
      <p className={s.label}>
        {n ? <span className={s.labelNo}>{numeral(n)}</span> : null}
        {label}
      </p>
      <h2 className={s.h2} id={id}>{h2}</h2>
      {sub && <p className={s.sub}>{rich(sub)}</p>}
    </div>
  );
}

/* ---------- prices ---------- */

function monthlyCents(stripePrices, key) {
  const live = stripePrices?.[key]?.monthlyCents;
  return live != null && live > 0 ? live : CATALOGUE[key].monthlyPriceCents;
}

/* ---------- sections ---------- */

function Header() {
  return (
    <header className={s.header}>
      <div className={s.wrap + ' ' + s.headerRow}>
        <a href="/" className={s.logo}>
          <img src="/logo-wordmark.svg" alt="MCPEmails" width={280} height={48} />
        </a>
        <nav aria-label={NAV.label} className={s.nav}>
          <ul className={s.navList}>
            {NAV.links.map((l) => (
              <li key={l.href} className={s.navHideSm}>
                <a href={l.href}>{l.label}</a>
              </li>
            ))}
            <li><a href={NAV.signIn.href}>{NAV.signIn.label}</a></li>
            <li><a href={NAV.start.href} className={s.navStart}>{NAV.start.label}</a></li>
          </ul>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className={s.hero} aria-labelledby="v01-h1">
      <div className={cx(s.wrap, s.heroGrid)}>
        <div className={s.heroText}>
          <p className={s.label}>{HERO.label}</p>
          <h1 id="v01-h1" className={s.h1}>{HERO.h1}</h1>
          <p className={s.lead}>{rich(HERO.lead)}</p>
          <p className={s.solo}>{HERO.solo}</p>
          <div className={s.ctas}>
            <a className={s.btnPrimary} href={HERO.primary.href}>{HERO.primary.label}</a>
            <a className={s.btnSecondary} href={HERO.secondary.href}>{HERO.secondary.label}</a>
          </div>
          <p className={s.meta}>
            {HERO.meta.join(' / ')} / <a href={HERO.tertiary.href}>{HERO.tertiary.label}</a>
          </p>
        </div>
        <nav className={s.index} aria-label={HERO.indexLabel}>
          <p className={s.label}>{HERO.indexLabel}</p>
          <ol className={s.indexList}>
            {HERO.index.map((row, i) => (
              <li key={row.id}>
                <a href={`#${row.id}`} className={s.indexLink}>
                  <span className={s.indexNo}>{numeral(i + 1)}</span>
                  <span className={s.indexTitle}>{row.title}</span>
                  <span className={s.indexLine}>{row.line}</span>
                  <span className={s.indexArrow} aria-hidden="true">↓</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </div>
      <SampleMailbox />
    </section>
  );
}

function SampleMailbox() {
  const drafts = SAMPLE.rows.filter((r) => r.draft != null).length;
  return (
    <div className={cx(s.wrap, s.sample)}>
      <div className={s.sampleHead}>
        <p className={s.label}>{SAMPLE.label}</p>
        <p className={s.sampleNote}>{SAMPLE.note}</p>
        <p className={s.samplePrompt}>{SAMPLE.prompt}</p>
      </div>
      <div className={s.sampleGrid}>
        <div className={s.pane} role="group" aria-label={`${SAMPLE.label}, before`}>
          <p className={s.paneHead}>
            <span>{SAMPLE.before.title}</span>
            <span>{SAMPLE.before.when}</span>
            <span>{SAMPLE.before.summary}</span>
          </p>
          <ul className={s.mailList}>
            {SAMPLE.rows.map((r) => (
              <li key={r.subject} className={cx(s.mail, s.unread)}>
                <span className={s.mailFrom}>{r.from}</span>
                <span className={s.mailTime}>{r.time}</span>
                <span className={s.mailSubject}>{r.subject}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className={s.pane} role="group" aria-label={`${SAMPLE.label}, after`}>
          <p className={s.paneHead}>
            <span>{SAMPLE.after.title}</span>
            <span>{SAMPLE.after.when}</span>
            <span>{SAMPLE.after.summary.replace(/^\d+/, String(drafts))}</span>
          </p>
          <ul className={s.mailList}>
            {SAMPLE.rows.map((r) => {
              const isDraft = r.draft != null;
              const held = isDraft && r.draft === CHOICES.heldDraft;
              const tone = isDraft ? (held ? s.toneHeld : s.toneAction) : null;
              return (
                <li key={r.subject} className={cx(s.mail, tone)}>
                  <span className={s.mailFrom}>{r.from}</span>
                  <span className={s.mailTime}>{r.time}</span>
                  <span className={s.mailSubject}>{isDraft ? `Re: ${r.subject}` : r.subject}</span>
                  <span className={s.mailState}>
                    {isDraft ? (held ? SAMPLE.heldState : SAMPLE.draftState) : r.after}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <figure className={s.clipFig}>
          <p className={s.paneHead}>
            <span>{SAMPLE.clip.title}</span>
          </p>
          <LoopClip
            desktop={{
              webm: `${A}/${CHOICES.heroClip}-light-desktop.webm`,
              mp4: `${A}/${CHOICES.heroClip}-light-desktop.mp4`,
              poster: `${A}/${CHOICES.heroClip}-light-desktop-poster`,
              width: 1428,
              height: CHOICES.heroClip === 'card-draft-send' ? 840 : 600,
            }}
            mobile={CHOICES.heroClip === 'card-draft-send' ? {
              webm: `${A}/card-draft-send-light-mobile.webm`,
              mp4: `${A}/card-draft-send-light-mobile.mp4`,
              poster: `${A}/card-draft-send-light-mobile-poster`,
              width: 784,
              height: 720,
            } : null}
            label={SAMPLE.clip.alt}
            frameClassName={s.clipBox}
            mediaClassName={s.clipMedia}
            buttonClassName={s.clipButton}
          />
          <figcaption className={s.caption}>{rich(SAMPLE.clip.caption)}</figcaption>
        </figure>
      </div>
    </div>
  );
}

function Spec() {
  return (
    <section className={cx(s.section, CHOICES.tintedSection === 'spec' && s.tinted)} id="features" aria-labelledby="v01-spec">
      <div className={s.wrap}>
        <SectionHead label={SPEC.label} h2={SPEC.h2} id="v01-spec" />
        <div className={s.specGrid}>
          <div className={s.specIntro}>
            {SPEC.paragraphs.map((p) => <p key={p.slice(0, 24)} className={s.body}>{rich(p)}</p>)}
            <ul className={s.linkList}>
              {SPEC.links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}
            </ul>
          </div>
          <div>
            <h3 className={s.h3}>{SPEC.h3}</h3>
            <dl className={s.specList}>
              {SPEC.rows.map((r) => (
                <div key={r.k} className={s.specRow}>
                  <dt>{r.k}</dt>
                  <dd>{rich(r.v)}</dd>
                </div>
              ))}
            </dl>
            <h3 className={s.h3}>{SPEC.keyLabel}</h3>
            <p className={s.small}>{SPEC.keyIntro}</p>
            <ul className={s.keyList}>
              {SPEC.key.map((k) => (
                <li key={k.tone} className={s.keyItem}>
                  <span className={cx(s.swatch, s[`sw_${k.tone}`])} aria-hidden="true" />
                  <span className={s.keyName}>{k.name}</span>
                  <span>{k.meaning}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Beliefs() {
  return (
    <section className={cx(s.section, CHOICES.tintedSection === 'beliefs' && s.tinted)} aria-labelledby="v01-beliefs">
      <div className={s.wrap}>
        <SectionHead label={BELIEFS.label} h2={BELIEFS.h2} sub={BELIEFS.sub} id="v01-beliefs" />
        <ol className={s.beliefs}>
          {BELIEFS.items.map((b, i) => (
            <li key={b.h} className={s.belief}>
              <span className={s.beliefNo} aria-hidden="true">{numeral(i + 1)}</span>
              <h3 className={s.h3}>{b.h}</h3>
              <p className={s.body}>{b.p}</p>
              <a className={s.more} href={b.link.href}>{b.link.label} <span aria-hidden="true">→</span></a>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Connect() {
  return (
    <section className={cx(s.section, CHOICES.tintedSection === 'connect' && s.tinted)} id="connect" aria-labelledby="v01-connect">
      <div className={s.wrap} id="how">
        <SectionHead n={1} label={CONNECT.label} h2={CONNECT.h2} sub={CONNECT.sub} id="v01-connect" />
        <ol className={s.steps}>
          {CONNECT.steps.map((st, i) => (
            <li key={st.h} className={s.step}>
              <span className={s.stepNo}>Step {i + 1}</span>
              <h3 className={s.h3}>{st.h}</h3>
              <p className={s.body}>{rich(st.p)}</p>
            </li>
          ))}
        </ol>
        <Figure n={CONNECT.fig1.n} caption={CONNECT.fig1.caption} className={s.figWide}>
          <div className={s.plate}>
            <Still name="dashboard-overview" desk={[2880, 1800]} mob={[780, 1688]} alt={CONNECT.fig1.alt} />
          </div>
        </Figure>
        <Figure n={CONNECT.diagram.n} caption={CONNECT.diagram.caption} className={s.figWide}>
          <div className={s.plateFlat}>
            <picture>
              <source media="(max-width: 767px) and (prefers-reduced-motion: reduce)" srcSet={`${C}/diagram-flow-mobile.svg`} width={358} height={252} />
              <source media="(max-width: 767px)" srcSet={`${C}/diagram-flow-mobile-animated.svg`} width={358} height={252} />
              <source media="(prefers-reduced-motion: reduce)" srcSet={`${C}/diagram-flow.svg`} width={960} height={432} />
              <img
                className={s.still}
                src={`${C}/diagram-flow-animated.svg`}
                width={960}
                height={432}
                alt="How it works: your chat app asks MCPEmails over MCP, MCPEmails fetches your inbox live, and you review each draft in the chat and click Send before it goes out from your own address."
                loading="lazy"
                decoding="async"
              />
            </picture>
          </div>
        </Figure>
      </div>
    </section>
  );
}

function Ask() {
  return (
    <section className={cx(s.section, CHOICES.tintedSection === 'ask' && s.tinted)} id="ask" aria-labelledby="v01-ask">
      <div className={s.wrap}>
        <SectionHead n={2} label={ASK.label} h2={ASK.h2} sub={ASK.sub} id="v01-ask" />
        <div className={s.askGrid}>
          <table className={s.ledger}>
            <thead>
              <tr>
                <th scope="col">{ASK.youAsk}</th>
                <th scope="col">{ASK.itDoes}</th>
              </tr>
            </thead>
            <tbody>
              {ASK.examples.map((e) => (
                <tr key={e.prompt}>
                  <td className={s.ledgerPrompt}>{e.prompt}</td>
                  <td>{e.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Figure n={ASK.fig2.n} caption={ASK.fig2.caption}>
            <div className={s.plate}>
              <Still name="card-draft" desk={[1364, 776]} mob={[720, 878]} alt={ASK.fig2.alt} />
            </div>
          </Figure>
        </div>
        <h3 className={s.h3}>{ASK.toolsH3}</h3>
        <dl className={s.tools}>
          {ASK.tools.map((t) => (
            <div key={t.name} className={s.tool}>
              <dt><code className={s.code}>{t.name}</code></dt>
              <dd>{t.p}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Approve() {
  return (
    <section className={s.section} id="approve" aria-labelledby="v01-approve">
      <div className={s.wrap}>
        <SectionHead n={3} label={APPROVE.label} h2={APPROVE.h2} sub={APPROVE.sub} id="v01-approve" />
        <div className={s.approveGrid}>
          <div>
            <ul className={s.states}>
              {APPROVE.states.map((st) => (
                <li key={st.h} className={cx(s.state, s[`st_${st.tone}`])}>
                  <h3 className={s.stateH}>{st.h}</h3>
                  <p className={s.body}>{rich(st.p)}</p>
                </li>
              ))}
            </ul>
            <p className={s.small}>{rich(APPROVE.relay)}</p>
          </div>
          <Figure n={APPROVE.fig2b.n} caption={APPROVE.fig2b.caption}>
            <HoverClip
              webm={`${A}/card-approval-flow-light-desktop.webm`}
              mp4={`${A}/card-approval-flow-light-desktop.mp4`}
              poster={`${A}/card-approval-flow-light-desktop-poster`}
              width={1428}
              height={600}
              label={APPROVE.fig2b.alt}
              className={s.hoverClip}
              mediaClassName={s.clipMedia}
            />
          </Figure>
        </div>
        <Figure n={APPROVE.fig2c.n} caption={APPROVE.fig2c.caption} className={s.figWide}>
          <HoverClip
            webm={`${A}/dashboard-approval-flow-light-desktop.webm`}
            mp4={`${A}/dashboard-approval-flow-light-desktop.mp4`}
            poster={`${A}/dashboard-approval-flow-light-desktop-poster`}
            width={1440}
            height={900}
            label={APPROVE.fig2c.alt}
            className={s.hoverClip}
            mediaClassName={s.clipMedia}
          />
        </Figure>
      </div>
    </section>
  );
}

function Security() {
  return (
    <section className={s.section} id="security" aria-labelledby="v01-security">
      <div className={s.wrap}>
        <SectionHead label={SECURITY.label} h2={SECURITY.h2} sub={SECURITY.sub} id="v01-security" />
        <Figure n={SECURITY.diagram.n} caption="What MCPEmails stores, and where." className={s.figWide}>
          <div className={s.plateFlat}>
            <picture>
              <source media="(prefers-reduced-motion: reduce)" srcSet={`${C}/diagram-stored.svg`} width={960} height={400} />
              <img
                className={s.still}
                src={`${C}/diagram-stored-animated.svg`}
                width={960}
                height={400}
                alt={SECURITY.diagram.alt}
                loading="lazy"
                decoding="async"
              />
            </picture>
          </div>
        </Figure>
        <dl className={s.secList}>
          {SECURITY.rows.map((r) => (
            <div key={r.k} className={s.specRow}>
              <dt>{r.k}</dt>
              <dd>{rich(r.v)}</dd>
            </div>
          ))}
        </dl>
        <p className={s.inlineLinks}>
          {SECURITY.links.map((l, i) => (
            <span key={l.href}>{i > 0 && ' / '}<a href={l.href}>{l.label}</a></span>
          ))}
        </p>
      </div>
    </section>
  );
}

function ProviderMark({ logo, name }) {
  if (!logo) return <span className={s.markTile} aria-hidden="true">{name[0]}</span>;
  const widths = { gmail: 27.71, outlook: 25.66, icloud: 29.94, fastmail: 26, yahoo: 25.73, yandex: 26, gmx: 42.03, webde: 24, imap: 26 };
  return (
    <img
      className={s.mark}
      src={`${C}/logo-${logo}-mono.svg`}
      width={widths[logo]}
      height={32}
      alt=""
      loading="lazy"
      decoding="async"
    />
  );
}

function Providers() {
  const shots = { 'dashboard-connect-gmail': [1280, 1800], 'dashboard-connect-pick-outlook': [1088, 1530], 'dashboard-connect-imap': [1280, 1800] };
  return (
    <section className={cx(s.section, CHOICES.tintedSection === 'providers' && s.tinted)} id="providers" aria-labelledby="v01-providers">
      <div className={s.wrap}>
        <SectionHead label={PROVIDERS.label} h2={PROVIDERS.h2} sub={PROVIDERS.sub} id="v01-providers" />
        <Figure n={PROVIDERS.fig3.n} caption={PROVIDERS.fig3.caption} className={s.figWide}>
          <div className={s.shots}>
            {PROVIDERS.fig3.shots.map((sh, i) => (
              <div key={sh.file} className={s.shot}>
                <div className={s.plate}>
                  <Still name={sh.file} desk={shots[sh.file]} alt={sh.alt} />
                </div>
                <p className={s.shotCap}><span className={s.figNo}>3{'abc'[i]}</span> {sh.cap}</p>
              </div>
            ))}
          </div>
        </Figure>
        <div className={s.wall}>
          <div>
            <h3 className={s.h3}>{PROVIDERS.providersH3}</h3>
            <ul className={s.wallList}>
              {PROVIDERS.providers.map((p) => (
                <li key={p.slug}>
                  <a href={`/connect/${p.slug}`} className={s.wallLink}>
                    <ProviderMark logo={p.logo} name={p.name} />
                    <span className={s.wallName}>{p.name}</span>
                    <span className={s.wallHow}>{p.how}</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className={s.inlineLinks}>
              {PROVIDERS.providersMore.map((l, i) => (
                <span key={l.href}>{i > 0 && ' / '}<a href={l.href}>{l.label}</a></span>
              ))}
            </p>
          </div>
          <div>
            <h3 className={s.h3}>{PROVIDERS.clientsH3}</h3>
            <ul className={s.wallList}>
              {PROVIDERS.clients.map((c) => (
                <li key={c.slug}>
                  <a href={`/docs/${c.slug}`} className={s.wallLink}>
                    <span className={s.markTile} aria-hidden="true">{c.name[0]}</span>
                    <span className={s.wallName}>{c.name}</span>
                    <span className={s.wallHow}>{c.how}</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className={s.inlineLinks}>
              {PROVIDERS.clientsMore.map((l, i) => (
                <span key={l.href}>{i > 0 && ' / '}<a href={l.href}>{l.label}</a></span>
              ))}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Reviews() {
  return (
    <section className={s.section} id="reviews" aria-labelledby="v01-reviews">
      <div className={s.wrap}>
        <SectionHead label={REVIEWS.label} h2={REVIEWS.h2} sub={REVIEWS.sub} id="v01-reviews" />
        {REVIEW_LIST.map((r) => (
          <figure key={r.id} className={s.review}>
            <blockquote className={s.quote}>
              <p>{r.quote}</p>
            </blockquote>
            <figcaption className={s.reviewBy}>
              <span className={s.reviewName}>{r.author}</span>
              {r.role && <span>{r.role}{r.company ? ', ' : ''}</span>}
              {r.company && (r.url ? <a href={r.url} rel="noopener">{r.company}</a> : <span>{r.company}</span>)}
              <span className={s.reviewMeta}>
                {REVIEWS.rated.replace('{rating}', String(r.rating))}
                {r.sourceUrl && (
                  <> / <a href={r.sourceUrl} rel="noopener">{REVIEWS.via.replace('Google', REVIEW_SOURCES[r.source]?.label ?? 'Google')}</a></>
                )}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function Teams({ stripePrices, eurEnabled, businessSeat, locale }) {
  const seat = businessSeat?.card ?? null;
  const minPeople = stripePrices?.pro?.perPerson?.minPeople ?? BUSINESS_MIN_SEATS;
  const flatFeatures = [
    `${BUSINESS_INCLUDED_INBOXES} mailboxes included, ${formatUsdCopy(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS, locale)} a month for each extra`,
    'Unlimited members with roles, at no extra cost',
    'Admins approve sends held for review',
    'Several workspaces on one subscription, one per company or client',
  ];
  const features = seat ? seat.features.filter((f) => !/^Everything in/.test(f)) : flatFeatures;
  return (
    <section className={s.section} id="teams" aria-labelledby="v01-teams">
      <div className={s.wrap}>
        <SectionHead n={4} label={TEAMS.label} h2={TEAMS.h2} sub={TEAMS.sub} id="v01-teams" />
        <div className={s.teamGrid}>
          <div className={s.team}>
            <p className={s.label}>{planDisplayName(TEAMS.soloPlan)}</p>
            <h3 className={s.h3}>{TEAMS.soloH3}</h3>
            <p className={s.teamPrice}>
              <Price usdCents={monthlyCents(stripePrices, 'solo')} eurCents={stripePrices?.solo?.eurMonthlyCents} eurEnabled={eurEnabled} locale={locale} className={s.amount} vatClassName={s.vat} />
              <span className={s.per}> {PLANS.perMonth}</span>
            </p>
            <p className={s.body}>{TEAMS.soloP}</p>
            <a className={s.more} href={TEAMS.founders.href}>{TEAMS.founders.label} <span aria-hidden="true">→</span></a>
          </div>
          <div className={s.team}>
            <p className={s.label}>{planDisplayName(TEAMS.teamPlan)}</p>
            <h3 className={s.h3}>{TEAMS.teamH3}</h3>
            <p className={s.teamPrice}>
              <Price usdCents={monthlyCents(stripePrices, 'pro')} eurCents={stripePrices?.pro?.eurMonthlyCents} eurEnabled={eurEnabled} locale={locale} className={s.amount} vatClassName={s.vat} />
              <span className={s.per}> {seat ? 'per person a month' : PLANS.perMonth}</span>
            </p>
            {seat && <p className={s.small}>{seat.minimum.replace(/^\{min\}/, String(minPeople))}</p>}
            <p className={s.body}>{rich(seat ? TEAMS.teamPSeat : TEAMS.teamPFlat)}</p>
            <ul className={s.ticks}>
              {features.map((f) => (
                <li key={f}><MoneyText text={f} eurEnabled={eurEnabled} locale={locale} /></li>
              ))}
            </ul>
            <a className={s.more} href={TEAMS.business.href}>{TEAMS.business.label} <span aria-hidden="true">→</span></a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Plans({ stripePrices, eurEnabled, businessSeat, locale }) {
  const seat = businessSeat?.card ?? null;
  const minPeople = stripePrices?.pro?.perPerson?.minPeople ?? BUSINESS_MIN_SEATS;
  const addon = formatUsdCopy(BUSINESS_EXTRA_INBOX_MONTHLY_CENTS, locale);
  const tiers = [
    { key: 'free', href: withReadingLang('/signup', locale) },
    { key: 'personal', href: withReadingLang(pricingUpgradeHref('personal', false, false, locale), locale) },
    { key: 'solo', href: withReadingLang(pricingUpgradeHref('solo', false, false, locale), locale) },
    { key: 'pro', href: withReadingLang(pricingUpgradeHref('pro', false, false, locale), locale) },
  ];
  const Y = true;
  const N = false;
  const rows = [
    ['Connected inboxes', ['1', '3', '10', seat
      ? `Up to ${BUSINESS_PRIVATE_INBOXES_PER_PERSON} private per person, plus ${BUSINESS_INCLUDED_INBOXES} company-wide, then ${addon} a month each`
      : `${BUSINESS_INCLUDED_INBOXES} included, then ${addon} a month each`]],
    ['People', ['One', 'One', 'One', seat ? `Unlimited, billed per person with a mailbox, ${minPeople} minimum` : 'Unlimited members with roles']],
    ['Read, search, organise, draft, schedule and send', [Y, Y, Y, Y]],
    ['Approval hold before a send', [Y, Y, Y, Y]],
    ['Gmail, Outlook, iCloud, Fastmail and any IMAP', [Y, Y, Y, Y]],
    ['Unlimited API keys', [Y, Y, Y, Y]],
    ['Burst rate limit', ['Standard', '2x', '5x', 'Highest']],
    ['Follow-up reminders and snooze', [N, N, Y, Y]],
    ['A daily morning brief in your inbox', [N, N, Y, Y]],
    ['Search every connected inbox at once', [N, N, Y, Y]],
    ['Instructions for your AI, per inbox', [N, N, Y, Y]],
    ['Roles: viewer, member, admin', [N, N, N, Y]],
    ['Admins approve sends held for review', [N, N, N, Y]],
    ['Several workspaces on one subscription', [N, N, N, Y]],
    ...(seat
      ? [
          ['Recipient rules for outgoing mail', [N, N, N, Y]],
          ['Audit log with CSV export', [N, N, N, Y]],
          ['Company invoices with your VAT ID, and a DPA', [N, N, N, Y]],
        ]
      : []),
    ['Support', ['Help center and email', 'Priority email', 'Priority email', 'Priority email']],
  ];
  const cell = (v) =>
    v === true ? <span className={s.yes}>{PLANS.yes}</span>
      : v === false ? <span className={s.no}>{PLANS.no}</span>
        : <MoneyText text={v} eurEnabled={eurEnabled} locale={locale} />;

  return (
    <section className={s.section} id="plans" aria-labelledby="v01-plans">
      <div className={s.wrap}>
        <SectionHead n={5} label={PLANS.label} h2={PLANS.h2} sub={seat ? PLANS.subSeat : PLANS.subFlat} id="v01-plans" />
        <div className={s.tableScroll} role="region" aria-label={PLANS.caption} tabIndex={0}>
          <table className={s.planTable}>
            <caption className={s.visuallyHidden}>{PLANS.caption}</caption>
            <thead>
              <tr>
                <td className={s.corner} />
                {tiers.map((t) => (
                  <th key={t.key} scope="col">
                    <span className={s.planName}>{planDisplayName(t.key)}</span>
                    <span className={s.planPrice}>
                      <Price
                        usdCents={monthlyCents(stripePrices, t.key)}
                        eurCents={stripePrices?.[t.key]?.eurMonthlyCents}
                        eurEnabled={eurEnabled}
                        locale={locale}
                        className={s.amount}
                        vatClassName={s.vat}
                      />
                    </span>
                    <span className={s.per}>
                      {t.key === 'free' ? PLANS.perForever : t.key === 'pro' && seat ? 'per person a month' : PLANS.perMonth}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, values]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  {values.map((v, i) => <td key={tiers[i].key} data-plan={planDisplayName(tiers[i].key)}>{cell(v)}</td>)}
                </tr>
              ))}
              <tr className={s.ctaRow}>
                <td className={s.corner} />
                {tiers.map((t) => (
                  <td key={t.key}>
                    <a className={t.key === 'free' ? s.btnPrimary : s.btnSecondary} href={t.href}>{PLANS.ctas[t.key]}</a>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {PLANS.notes.map((n) => <p key={n} className={s.small}>{n}</p>)}
        <p className={s.small}><a href={PLANS.compare.href}>{PLANS.compare.label}</a><Fn k="pricing" /> / <a href="mailto:hello@mcpemails.com">hello@mcpemails.com</a></p>
      </div>
    </section>
  );
}

function Faq({ faqItems, eurEnabled, locale }) {
  if (!faqItems?.length) return null;
  return (
    <section className={s.section} id="faq" aria-labelledby="v01-faq">
      <div className={s.wrap}>
        <SectionHead label={FAQ.label} h2={FAQ.h2} sub={FAQ.sub} id="v01-faq" />
        <ol className={s.faq}>
          {faqItems.map((item, i) => (
            <li key={item.q} className={s.faqItem}>
              <span className={s.faqNo} aria-hidden="true">Q{i + 1}</span>
              <h3 className={s.faqQ}>{item.q}</h3>
              <p className={s.body}><MoneyText text={item.a} eurEnabled={eurEnabled} locale={locale} /></p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Footnotes() {
  return (
    <section className={s.section} id="footnotes" aria-labelledby="v01-footnotes">
      <div className={s.wrap}>
        <SectionHead label={FOOTNOTES_SECTION.label} h2={FOOTNOTES_SECTION.h2} sub={FOOTNOTES_SECTION.sub} id="v01-footnotes" />
        <ol className={s.notes}>
          {FOOTNOTES.map((f, i) => (
            <li key={f.key} id={`fn-${f.key}`} className={s.note}>
              <span className={s.noteNo}>{i + 1}</span>
              <span>{f.claim} <a href={f.href}>{f.source}</a></span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className={s.footer}>
      <div className={s.wrap}>
        <div className={s.closing}>
          <h2 className={s.h2}>{CLOSING.h2}</h2>
          <p className={s.body}>{CLOSING.p}</p>
          <div className={s.ctas}>
            <a className={s.btnPrimary} href={HERO.primary.href}>{HERO.primary.label}</a>
            <a className={s.btnSecondary} href={HERO.secondary.href}>{HERO.secondary.label}</a>
          </div>
        </div>
        <div className={s.footGrid}>
          <div className={s.footBrand}>
            <img src="/logo-wordmark.svg" alt="MCPEmails" width={280} height={48} className={s.footLogo} loading="lazy" />
            <p className={s.small}>{FOOTER.tagline}</p>
            <p className={s.small}>
              <span className={s.labelInline}>{FOOTER.mcpLabel}</span> <code className={s.code}>{MCP_URL}</code>
            </p>
            <p className={s.small}>
              <span className={s.labelInline}>{FOOTER.contactLabel}</span>{' '}
              <a href="mailto:support@mcpemails.com">support@mcpemails.com</a>
            </p>
          </div>
          {FOOTER.columns.map((col) => (
            <div key={col.h}>
              <p className={s.label}>{col.h}</p>
              <ul className={s.footList}>
                {col.links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className={s.footBottom}>
          <p className={s.small}>
            <span className={s.labelInline}>{FOOTER.languagesLabel}</span>{' '}
            {FOOTER.languages.map((l, i) => (
              <span key={l.href}>{i > 0 && ' / '}<a href={l.href} hrefLang={l.lang} lang={l.lang}>{l.label}</a></span>
            ))}
          </p>
          <p className={s.small}>{FOOTER.legal}</p>
          <p className={s.small}>{FOOTER.entity}</p>
          <p className={s.small}>{FOOTER.copyright}</p>
        </div>
      </div>
    </footer>
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
  return (
    <div className={s.page}>
      <link rel="preload" href={H1_FONT.pathname} as="font" type="font/woff2" crossOrigin="anonymous" data-v01-font="" />
      <Header />
      <main>
        <Hero />
        <Spec />
        <Beliefs />
        <Connect />
        <Ask />
        <Approve />
        <Security />
        <Providers />
        <Reviews />
        <Teams stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} locale={locale} />
        <Plans stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} locale={locale} />
        <Faq faqItems={faqItems} eurEnabled={eurEnabled} locale={locale} />
        <Footnotes />
      </main>
      <Footer />
    </div>
  );
}
