/**
 * "What needs attention": the second thing on the sheet, and the only part of
 * the page that tells the reader what to do rather than what is true.
 *
 * WHY IT IS SECOND AND FULL WIDTH. It could have gone in a rail beside the
 * money, and that is where a dashboard usually puts its alerts. But this page
 * has exactly one reader, who opens it weekly to answer "how is the business
 * doing and what should I do about it", and the second half of that sentence
 * was what neither previous design ever answered. Putting the answer in a
 * gutter would be saying it is supporting material.
 *
 * THE LIST IS COMPUTED, NEVER CURATED. Every item comes from a threshold in
 * `growth-attention.ts`, carries the number that tripped it and names the
 * population it was counted over. Nothing here is scored, ranked by a model,
 * or phrased as advice; each line is a fact plus the fact that it crossed a
 * line somebody wrote down.
 *
 * AN EMPTY LIST STATES ITS OWN PROVENANCE. "Nothing" and "this panel failed to
 * load" look identical if the empty state is a blank space, so the footer
 * always says how many checks ran and how many could not, and the blocked ones
 * are counted rather than being allowed to pass silently.
 */

import type { AttentionReport } from '@/lib/analytics/growth-attention';
import { formatCount } from '../charts/format';

export function Attention({ report }: { report: AttentionReport }) {
  const acts = report.items.filter((item) => item.severity === 'act').length;

  return (
    <>
      {report.items.length === 0 ? (
        <p className="br-todo-clear">Nothing crossed a threshold.</p>
      ) : (
        <ol className="br-todo">
          {report.items.map((item) => (
            <li key={item.id} className={`is-${item.severity}`}>
              <span className="br-todo-mark" aria-hidden="true" />
              <span className="br-todo-kind">{item.severity === 'act' ? 'Act' : 'Watch'}</span>
              <span className="br-todo-body">
                <span className="br-todo-title">{item.title}</span>
                <span className="br-todo-pop">{item.population}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="br-todo-foot">
        {formatCount(report.checksRun)} checks ran
        {report.items.length > 0 && `, ${formatCount(acts)} to act on`}
        {report.checksBlocked > 0
          ? `. ${formatCount(report.checksBlocked)} could not run because the read they depend on failed, so their conditions are unknown rather than clear.`
          : '. None were blocked by a failed read.'}
      </p>
    </>
  );
}
