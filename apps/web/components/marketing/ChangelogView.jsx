import { Nav, Footer } from './Sections';

/**
 * /changelog, rendered on the server.
 *
 * Everything on this page is static: entries come from src/lib/changelog and
 * nothing here has state, so there is no reason to ship it to the browser.
 * Nav and Footer are the site's own client components and are used exactly as
 * the other static marketing pages use them.
 */

const CONTACT_EMAIL = 'hello@mcpemails.com';

function formatDay(iso, locale) {
  // UTC, so a reader west of Greenwich never sees an entry dated a day early.
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatMonth(monthKey, locale) {
  return new Date(`${monthKey}-01T00:00:00Z`).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

function Entry({ entry, copy, locale }) {
  return (
    <li className="cl-entry">
      <div className="cl-entry-meta">
        <time className="cl-entry-date" dateTime={entry.date}>
          {formatDay(entry.date, locale)}
        </time>
        <span className={`cl-kind cl-kind-${entry.kind}`}>
          {copy.kinds[entry.kind] ?? entry.kind}
        </span>
      </div>
      <div className="cl-entry-body">
        <h3 className="cl-entry-title">{entry.title}</h3>
        <p className="cl-entry-text">{entry.body}</p>
      </div>
    </li>
  );
}

export default function ChangelogView({ locale, copy, months }) {
  return (
    <div>
      <Nav />

      <section className="pricing-page-hero" style={{ paddingBottom: 40 }}>
        <div className="container" style={{ maxWidth: 800 }}>
          <div className="eye-label">{copy.eyebrow}</div>
          <h1 className="pricing-page-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>
            {copy.title}
          </h1>
          <p className="pricing-page-lead" style={{ maxWidth: 620, marginBottom: 0 }}>
            {copy.lead}
          </p>
        </div>
      </section>

      <section className="section cl-section">
        <div className="container" style={{ maxWidth: 800 }}>
          {months.map((month) => (
            <section className="cl-month" key={month.key}>
              <h2 className="cl-month-title">{formatMonth(month.key, locale)}</h2>
              <ul className="cl-list">
                {month.entries.map((entry, i) => (
                  <Entry
                    key={`${entry.date}-${i}`}
                    entry={entry}
                    copy={copy}
                    locale={locale}
                  />
                ))}
              </ul>
            </section>
          ))}

          <p className="cl-footnote">
            {copy.footnote}{' '}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
}
