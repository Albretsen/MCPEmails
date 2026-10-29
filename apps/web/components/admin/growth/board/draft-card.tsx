/**
 * The draft card band: one answer (keep the card or not) and the three
 * numbers it rests on. Rates and checks are src/lib/analytics/draft-card.ts.
 *
 * Aggregates only. No account, address or draft content is on this page.
 */

import type { GrowthDraftCardReachRow, GrowthDraftCardStatsRow } from '@/lib/analytics/growth-types';
import {
  BARS,
  CARD_FAMILIES,
  DRAFT_CARD_RELEASE_AT,
  MIN_CARD_DRAFTS,
  rates,
  totals,
  type Check,
  type ReleaseVerdict,
} from '@/lib/analytics/draft-card';
import { formatCount, formatPercent } from '../../charts';
import { Tile } from '../../kiosk/primitives';
import { BigStats } from './big-stats';
import { Verdict } from './panels';

const pct = (value: number | null) => (value === null ? 'n/a' : formatPercent(value, 0));

export function DraftCardTile({
  verdict,
  checks,
  rows,
  reach,
}: {
  verdict: ReleaseVerdict;
  checks: Check[];
  rows: GrowthDraftCardStatsRow[];
  reach: GrowthDraftCardReachRow | null;
}) {
  const state = (key: string) => checks.find((c) => c.key === key)?.state ?? 'wait';
  const afterTotals = totals(rows, 'after', CARD_FAMILIES);
  const after = rates(afterTotals);
  const before = rates(totals(rows, 'before', CARD_FAMILIES));
  // Claude.ai on its own: the client the card was built for.
  const claudeTotals = totals(rows, 'after', ['claude']);
  const claude = rates(claudeTotals);
  const enabled = Number(reach?.enabled ?? 0);
  const hidden = Number(reach?.hidden_workspaces ?? 0);
  const failing = checks.some((c) => c.state === 'fail');
  // While it waits, say what for in numbers, not which check.
  const reason =
    verdict.headline === 'Too early' && !failing
      ? `Judged once ${MIN_CARD_DRAFTS} card drafts are a day old (${formatCount(afterTotals.mature_listed)} so far).`
      : verdict.reason;
  return (
    <Tile
      label="Keep the draft card?"
      aside={DRAFT_CARD_RELEASE_AT ? `since ${DRAFT_CARD_RELEASE_AT.slice(0, 10)}, customers` : 'not released'}
      tone={verdict.level === 'ok' ? 'good' : verdict.level === 'down' ? 'bad' : verdict.level === 'degraded' ? 'warn' : 'default'}
    >
      <Verdict level={verdict.level} headline={verdict.headline} reason={reason} />
      <BigStats
        stats={[
          {
            label: 'Used the card',
            value: pct(after.touched),
            note: `of ${formatCount(afterTotals.lines_listed)} drafts where it shows · Claude.ai ${pct(claude.touched)} of ${formatCount(claudeTotals.lines_listed)} · needs ${formatPercent(BARS.touched, 0)}`,
            state: state('used'),
          },
          {
            label: 'Sent within a day',
            value: pct(after.sentListed),
            note: `was ${pct(before.sent)} · may drop ${formatPercent(BARS.sendDrop, 0)}`,
            state: state('harm'),
          },
          {
            label: 'Turned it off',
            value: formatCount(hidden),
            note: `of ${formatCount(enabled)} workspaces · needs under ${formatPercent(BARS.optOut, 0)}`,
            state: state('rejected'),
          },
        ]}
      />
    </Tile>
  );
}
