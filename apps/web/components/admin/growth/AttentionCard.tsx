/**
 * "Needs attention": the computed to-do list, as one line per item.
 *
 * WHY IT IS ONE LINE. The previous version of this card gave every item a
 * sentence and then a second sentence naming the population it was counted
 * over, and the page it sat on was fairly described as a wall of text. The
 * population still has to be stated, because a number without its denominator
 * is exactly how this dashboard has misled before, so it is a muted suffix on
 * the same line instead of a paragraph under it.
 *
 * The list is computed in src/lib/analytics/growth-attention.ts from
 * thresholds written down in code. Nothing here is a judgement: each line is a
 * fact, plus the fact that it crossed a line somebody set.
 *
 * AN EMPTY LIST STATES ITS OWN PROVENANCE. "Nothing is wrong" and "this panel
 * failed to load" look identical if the empty state is blank space, so the
 * footer always reports how many checks ran and how many could not run because
 * the read they depend on failed.
 */

import type { AttentionItem, AttentionReport } from '@/lib/analytics/growth-attention';
import { formatCount } from '../charts';

/** Shown before the rest collapse. Six fills the card without scrolling it. */
const VISIBLE = 6;

export function AttentionCard({ report }: { report: AttentionReport }) {
  const acts = report.items.filter((item) => item.severity === 'act').length;
  const shown = report.items.slice(0, VISIBLE);
  const rest = report.items.slice(VISIBLE);

  return (
    <figure className="ac-card">
      <figcaption className="ac-head">
        <h3 className="ac-title">Needs attention</h3>
        <p className="ac-sub">
          {report.items.length === 0
            ? 'Every threshold checked, none crossed.'
            : `${formatCount(acts)} to act on, ${formatCount(report.items.length - acts)} to watch.`}
        </p>
      </figcaption>

      {report.items.length === 0 ? (
        <p className="bd-todo-clear">Nothing crossed a threshold.</p>
      ) : (
        <Items items={shown} />
      )}

      {rest.length > 0 && (
        <details className="bd-drawer">
          <summary>{formatCount(rest.length)} more</summary>
          <Items items={rest} />
        </details>
      )}

      <p className="bd-todo-foot">
        {formatCount(report.checksRun)} checks ran.{' '}
        {report.checksBlocked > 0
          ? `${formatCount(report.checksBlocked)} could not: the read they depend on failed, so their conditions are unknown rather than clear.`
          : 'None were blocked by a failed read.'}
      </p>
    </figure>
  );
}

function Items({ items }: { items: AttentionItem[] }) {
  return (
    <ol className="bd-todo">
      {items.map((item) => (
        <li key={item.id} className={`is-${item.severity}`}>
          <span className="bd-todo-dot" aria-hidden="true" />
          <span>
            <span className="bd-todo-title">{item.title}</span>{' '}
            <span className="bd-todo-pop">{item.population}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
