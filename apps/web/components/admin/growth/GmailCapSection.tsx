/**
 * Gmail OAuth headroom: how much of Google's 100-user cap is spent.
 *
 * The OAuth client requests four restricted Gmail scopes and is published but
 * unverified (proof: inboxes created in May still refresh their tokens, which
 * a Testing-mode client could not do past 7 days). Google caps such a client
 * at 100 distinct accounts that have ever granted consent, and the count is
 * CUMULATIVE: revoking access or deleting an inbox does not return a slot.
 * That is why the number here counts soft-deleted inboxes too.
 *
 * Lifting the cap needs Google verification plus the CASA security assessment,
 * which takes weeks of calendar time. The cap does not pause while that runs,
 * so the card warns on lead time rather than on the cap itself.
 *
 * Our count is a FLOOR. Google counts a grant the moment consent is given, so
 * anyone who consented and then failed before the inbox row was written spends
 * a slot invisible to us. The authoritative figure lives in the Google Cloud
 * Console and is recorded by hand in `admin_oauth_cap_snapshots`.
 */

import { fetchGmailCapSummary, gmailCapProjection } from '@/lib/analytics/growth-queries';
import { GMAIL_OAUTH_USER_CAP } from '@/lib/analytics/growth-types';
import { ProgressMeter, formatCount } from '../charts';
import { MetricLink } from '../MetricLink';
import { SectionError, Section } from './shared';

const MONTH_FORMAT = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function monthLabel(value: string | null) {
  if (!value) return null;
  return MONTH_FORMAT.format(new Date(`${value}-01T00:00:00Z`));
}

export async function GmailCapSection() {
  const result = await fetchGmailCapSummary();
  if (!result.ok) return <SectionError title="Gmail OAuth headroom" message={result.error} />;

  const summary = result.data;
  const projection = gmailCapProjection(summary);
  const exhaustion = monthLabel(projection.projectedExhaustion);

  return (
    <Section
      title="Gmail OAuth headroom"
      explain={
        <>
          Google caps a published-but-unverified client with restricted Gmail scopes at{' '}
          <strong>{GMAIL_OAUTH_USER_CAP} distinct accounts that have ever granted consent</strong>, and the
          count is cumulative: revoking access or deleting an inbox does not return a slot, which is why
          soft-deleted inboxes are counted here. Our figure is a floor, because Google counts a grant the
          moment consent is given and anyone who consented then failed before an inbox row was written
          spends a slot we cannot see. Lifting the cap needs Google verification plus the CASA assessment,
          which take weeks and do not pause while the cap keeps filling. The authoritative number is in the
          Google Cloud Console.
          {summary.google_reported_users !== null
            && ` Console last reported ${summary.google_reported_users} on ${summary.google_reported_at?.slice(0, 10)}.`}
        </>
      }
      aside={projection.level === 'ok' ? undefined : (
        <span className={`growth-cap-flag is-${projection.level}`}>
          Start verification: {formatCount(projection.remaining)} slots left
          {exhaustion ? `, full around ${exhaustion}` : ''}
        </span>
      )}
    >
      <div className="growth-cap">
        {/* Thresholds are fractions of the cap: amber from 60 grants, red from 80. */}
        <ProgressMeter
          value={projection.used}
          max={GMAIL_OAUTH_USER_CAP}
          label="Gmail OAuth grants used"
          note="Distinct Google accounts that have ever granted consent to the app."
          unit="grants"
          thresholds={{ warn: 0.6, danger: 0.8 }}
        />

        <dl className="growth-cap-facts">
          <div><dt>New in 30 days</dt><dd>{formatCount(summary.grants_last_30d)}</dd></div>
          <div><dt>Rate</dt><dd>{projection.ratePerMonth.toFixed(1)} / month</dd></div>
          <div><dt>Slots left</dt><dd>{formatCount(projection.remaining)}</dd></div>
          <div><dt>Projected full</dt><dd>{exhaustion ?? 'No growth'}</dd></div>
          <div><dt>Connected now</dt><dd>{formatCount(summary.active)}</dd></div>
          <div style={{ alignSelf: 'end' }}>
            <MetricLink metricKey="gmail_grants">Grant history</MetricLink>
          </div>
        </dl>
      </div>
    </Section>
  );
}
