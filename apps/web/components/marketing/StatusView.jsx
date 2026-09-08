import { fill } from '@/lib/status/content.mjs';

/**
 * The public status page body.
 *
 * A server component with no interactivity on purpose. The page has to render
 * when things are going badly, which is the only time anyone loads it, so it
 * ships no JavaScript of its own: no polling, no client-side clock, no charting
 * library. Everything is text and coloured divs that survive a bad network.
 *
 * NO NUMBER IS TYPED IN THIS FILE. Every figure comes from the snapshot the
 * monitor recorded; every branch that has no figure renders the absence rather
 * than a plausible substitute. `snapshot.ok === false` renders the explicit
 * "we cannot read our monitor" panel instead of a stale or invented reading.
 *
 * TIMES ARE ABSOLUTE AND UTC, never "3 minutes ago". The page is ISR cached for
 * the monitor's own five minute cadence, so a relative time baked into the HTML
 * would keep saying "1 minute ago" for five minutes, which is a small lie of
 * exactly the kind this page cannot afford. An absolute timestamp is still true
 * however long the cache holds it, and lets the reader judge the freshness.
 */
/** Same address the site footer publishes. Kept in sync by hand, one place each. */
const CONTACT_EMAIL = 'hello@mcpemails.com';

export default function StatusView({ locale, content, snapshot }) {
  const c = content;
  // The window length is the snapshot's, never a constant typed here: if the
  // data module ever publishes a different window, the labels move with it
  // instead of quietly describing the wrong period.
  const days = snapshot.ok ? String(snapshot.windowDays) : null;

  return (
    <section className="section st-page" style={{ paddingTop: 8, paddingBottom: 88 }}>
      <div className="container" style={{ maxWidth: 860 }}>
        {snapshot.ok ? (
          <>
            <UptimeBlock c={c} locale={locale} snapshot={snapshot} days={days} />
            <History c={c} locale={locale} snapshot={snapshot} days={days} />
            <Components c={c} locale={locale} snapshot={snapshot} days={days} />
            <Incidents c={c} locale={locale} snapshot={snapshot} days={days} />
          </>
        ) : (
          <div className="st-card st-unavailable">
            <h2>{c.unavailable.title}</h2>
            <p>{c.unavailable.body}</p>
          </div>
        )}

        <div className="st-card">
          <h2>{c.scope.title}</h2>
          <ul className="st-scope">
            {c.scope.points.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        </div>

        <p className="st-note">{c.footer.source}</p>
        <p className="st-note">
          <a href={locale === 'en' ? '/security' : `/${locale}/security`}>{c.footer.securityLink}</a>
        </p>
        {/*
          The escape hatch, and the reason it is on this page rather than only
          in the footer. Four synthetic checks cannot see everything, so the
          page has to invite the correction it cannot detect: somebody whose
          experience contradicts a green banner is the most valuable monitoring
          signal we have and the one the cron will never produce.
        */}
        <p className="st-note">
          {splitAround(c.footer.contact, '{email}').map((part, i) =>
            part === '{email}' ? (
              <a key={i} href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            ) : (
              <span key={i}>{part}</span>
            ),
          )}
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- the banner */

/**
 * The headline state, rendered above the fold in the hero.
 *
 * Exported separately so the hero can carry it while the rest of the page sits
 * in the body section below.
 */
export function StatusBanner({ c, locale, snapshot }) {
  const state = snapshot.ok ? snapshot.overall : 'unknown';
  const checkedAt = snapshot.ok ? snapshot.lastCheckAt : null;
  return (
    <div className={`st-banner st-${state}`} role="status">
      <span className="st-dot" aria-hidden="true" />
      <div>
        <p className="st-banner-head">{c.overall[state]}</p>
        <p className="st-banner-note">{c.overallNote[state]}</p>
        <p className="st-banner-time">
          {checkedAt
            ? fill(c.checked.at, { time: formatDateTime(locale, checkedAt) })
            : c.checked.never}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- the figure */

function UptimeBlock({ c, locale, snapshot, days }) {
  const numbers = new Intl.NumberFormat(locale);
  return (
    <div className="st-card st-uptime">
      <p className="st-uptime-label">{fill(c.uptime.label, { days })}</p>
      {/*
        Truncated, never rounded. 99.996% rounded to two places prints as
        100.00%, which is a claim of no downtime over a window that recorded
        some. Flooring can only ever understate, which is the one direction a
        published uptime figure is allowed to be wrong in.
      */}
      <p className="st-uptime-figure">
        {snapshot.uptime === null ? '--' : `${floorPercent(snapshot.uptime, 2)}%`}
      </p>
      {snapshot.uptime === null ? (
        <p className="st-uptime-sub">{c.uptime.noFigure}</p>
      ) : (
        <p className="st-uptime-sub">
          {fill(c.uptime.checks, {
            checks: numbers.format(snapshot.checks),
            cadence: numbers.format(snapshot.cadenceMinutes),
          })}
          {c.punct.join}
          {snapshot.failed === 0
            ? capitalise(c.uptime.failedNone)
            : fill(c.uptime.failed, { failed: numbers.format(snapshot.failed) })}
          {c.punct.end}
        </p>
      )}
      {snapshot.monitoringSince ? (
        <p className="st-uptime-since">
          {fill(c.uptime.since, { date: formatDate(locale, snapshot.monitoringSince) })}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- the strip */

function History({ c, locale, snapshot, days }) {
  // Which UTC days actually held a confirmed incident, by the same rule the
  // monitor pages on: two or more consecutive failures, or one of a class that
  // pages at once. A day with a single failed check out of 288 is not that, and
  // painting it the same colour as a real outage overstates the month as badly
  // as hiding it would understate it. Both are still visible, in different
  // weights, and neither the uptime figure nor the failure count moves.
  const incidentDays = new Set(
    snapshot.incidents.flatMap((i) => {
      const from = new Date(i.startedAt);
      const to = new Date(i.lastFailureAt);
      const out = [];
      for (let d = from; d <= to; d = new Date(d.getTime() + 86_400_000)) {
        out.push(d.toISOString().slice(0, 10));
      }
      return out;
    }),
  );
  return (
    <div className="st-card">
      <h2>{fill(c.history.title, { days })}</h2>
      <ul className="st-strip">
        {snapshot.days.map((day) => {
          const label =
            day.checks === 0
              ? fill(c.history.noData, { date: formatDate(locale, `${day.date}T00:00:00.000Z`) })
              : day.failed === 0
                ? fill(c.history.allOk, {
                    date: formatDate(locale, `${day.date}T00:00:00.000Z`),
                    checks: day.checks,
                  })
                : fill(c.history.someFailed, {
                    date: formatDate(locale, `${day.date}T00:00:00.000Z`),
                    checks: day.checks,
                    failed: day.failed,
                  });
          // A day nobody counted is grey, never green. The bar says "no data"
          // because that is what it is, and a status page that paints its own
          // blind spots as clean days is worse than one with a gap in it.
          const tone =
            day.checks === 0
              ? 'none'
              : day.failed === 0
                ? 'ok'
                : incidentDays.has(day.date)
                  ? 'failed'
                  : 'blip';
          return (
            <li key={day.date} className={`st-bar st-bar-${tone}`} title={label}>
              <span className="st-sr">{label}</span>
            </li>
          );
        })}
      </ul>
      <div className="st-strip-ends">
        <span>{fill(c.history.oldest, { days })}</span>
        <span>{c.history.newest}</span>
      </div>
      <div className="st-legend">
        <span><i className="st-swatch st-bar-ok" />{c.history.legendOk}</span>
        <span><i className="st-swatch st-bar-blip" />{c.history.legendBlip}</span>
        <span><i className="st-swatch st-bar-failed" />{c.history.legendFailed}</span>
        <span><i className="st-swatch st-bar-none" />{c.history.legendNone}</span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- the four steps */

function Components({ c, locale, snapshot, days }) {
  const numbers = new Intl.NumberFormat(locale);
  return (
    <div className="st-card">
      <h2>{c.components.title}</h2>
      <p className="st-lead">{c.components.lead}</p>
      <div className="legal-table-wrap">
        <table className="legal-table st-table">
          <thead>
            <tr>
              <th>{c.components.thStep}</th>
              <th>{c.components.thNow}</th>
              <th>{fill(c.components.thWindow, { days })}</th>
            </tr>
          </thead>
          <tbody>
            {/* Already in the order the monitor runs them; see STEP_ORDER. */}
            {snapshot.components.map((item) => {
              const id = item.id;
              const copy = c.components.items[id] ?? { name: id, detail: '' };
              return (
                <tr key={id}>
                  <td>
                    <strong>{copy.name}</strong>
                    <span className="st-step-detail">{copy.detail}</span>
                  </td>
                  <td>
                    <span className={`st-pill st-pill-${item ? item.state : 'unknown'}`}>
                      {c.components.state[item ? item.state : 'unknown']}
                    </span>
                  </td>
                  <td>
                    {!item || item.rate === null ? (
                      <span className="st-muted">{c.components.noData}</span>
                    ) : (
                      <>
                        <strong>{floorPercent(item.rate, 2)}%</strong>
                        <span className="st-step-detail">
                          {fill(c.components.attempted, {
                            attempted: numbers.format(item.attempted),
                          })}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- incidents */

function Incidents({ c, locale, snapshot, days }) {
  const numbers = new Intl.NumberFormat(locale);
  return (
    <div className="st-card">
      <h2>{c.incidents.title}</h2>
      <p className="st-lead">{c.incidents.lead}</p>

      {snapshot.incidents.length === 0 ? (
        <p className="st-none">{fill(c.incidents.none, { days })}</p>
      ) : (
        <ol className="st-incidents">
          {snapshot.incidents.map((incident) => (
            <li key={incident.startedAt}>
              <p className="st-incident-when">{formatDateTime(locale, incident.startedAt)}</p>
              <p className="st-incident-what">
                {c.incidents.class[incident.failureClass] ?? incident.failureClass}
              </p>
              <p className="st-incident-meta">
                {incident.failedChecks === 1
                  ? c.incidents.checksOne
                  : fill(c.incidents.checks, { count: numbers.format(incident.failedChecks) })}
                {c.punct.join}
                {fill(c.incidents.affected, {
                  step: c.components.items[incident.failedStep]?.name ?? incident.failedStep,
                })}
                {c.punct.join}
                {incident.recoveredAt
                  ? fill(c.incidents.recovered, {
                      time: formatDateTime(locale, incident.recoveredAt),
                    })
                  : c.incidents.openStill}
                {c.punct.end}
                {/*
                  Punctuation and the space before it come from the locale, not
                  from this file. A hardcoded ". " is wrong in Chinese, where
                  the sentence ends in a full-width stop and no space follows
                  it, and this page renders in five languages.
                */}
                {incident.pagedImmediately
                  ? `${c.punct.space}${c.incidents.paged}${c.punct.end}`
                  : ''}
              </p>
            </li>
          ))}
        </ol>
      )}

      {snapshot.singleCheckFailures > 0 ? (
        <p className="st-note st-blips">
          {snapshot.singleCheckFailures === 1
            ? c.incidents.blipsOne
            : fill(c.incidents.blips, {
                count: numbers.format(snapshot.singleCheckFailures),
              })}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

/**
 * A fraction as a percentage, TRUNCATED to `places` decimals.
 *
 * Never `toFixed`, which rounds, and rounding up is the one arithmetic mistake
 * this page must be structurally incapable of making.
 */
function floorPercent(fraction, places) {
  const scale = 10 ** places;
  return (Math.floor(fraction * 100 * scale) / scale).toFixed(places);
}

/** A UTC date, in the reader's language. Rendered on the server, so stable. */
function formatDate(locale, iso) {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

/** A UTC date and time. The zone is named so nobody has to guess. */
function formatDateTime(locale, iso) {
  const formatted = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(new Date(iso));
  return `${formatted} UTC`;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Split a copy string around a placeholder, keeping the placeholder as its own
 * piece so the caller can render it as an element.
 *
 * `fill` is for text; this is for the one string that needs a link in the
 * middle of it. The alternative would be markup inside a translated string,
 * which is exactly the shape that bit us before: next-intl unescapes an
 * escaped angle bracket in dev and prints it literally in prod, so a sentence
 * that looked right locally shipped broken. Splitting on a plain token has no
 * such failure mode in any locale.
 */
function splitAround(template, token) {
  if (typeof template !== 'string') return [];
  return template.split(token).flatMap((part, i) => (i === 0 ? [part] : [token, part]));
}
