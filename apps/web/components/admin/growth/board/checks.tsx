/**
 * Shared pieces for the test read-out bands (onboarding, draft card): a list
 * of checks that shows each check's numbers under its question, and a drawer
 * for the counting rules so they stop crowding the numbers.
 */

import type { ReactNode } from 'react';

type CheckState = 'pass' | 'fail' | 'wait';

const STATE_WORDS: Record<CheckState, string> = { pass: 'Pass', fail: 'Fail', wait: 'Waiting' };

export type CheckRow = {
  key: string;
  question: string;
  state: CheckState;
  /** The numbers behind the state, in a short line under the question. */
  detail: string;
  /** What passing means, appended to the detail. */
  bar?: string;
  /** Informs only: shown greyed, never decides the verdict. */
  quiet?: boolean;
};

export function CheckList({ checks }: { checks: CheckRow[] }) {
  return (
    <ul className="gb-checks">
      {checks.map((check) => (
        <li key={check.key} className={`is-${check.state}${check.quiet ? ' is-quiet' : ''}`}>
          <span className="gb-check-q">{check.question}</span>
          <span className="gb-check-state">{STATE_WORDS[check.state]}</span>
          <span className="gb-check-detail">
            {check.detail}
            {check.bar && <span className="gb-check-bar"> · needs {check.bar}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function HowCounted({ children }: { children: ReactNode }) {
  return (
    <details className="gb-drawer">
      <summary>How this is counted</summary>
      <p className="bd-note">{children}</p>
    </details>
  );
}
