/**
 * "Where did they hear about us?": the self-reported answers to the one-time
 * dashboard question (components/dashboard/HeardAboutCard.jsx), all time, with
 * how many of the workspaces behind each answer have paid. Internal owners are
 * excluded in SQL (growth_heard_about). 'dismissed' stays in the table: how
 * many people skip the question is part of how far to trust the rest.
 */

import { Tile } from '../../kiosk/primitives';
import { formatCount, ratio } from '../../charts/format';
import type { GrowthHeardAboutRow } from '@/lib/analytics/growth-types';

const LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT answer',
  claude: 'Claude answer',
  gemini: 'Gemini or Google AI answer',
  google_search: 'Google search',
  colleague: 'A colleague or friend',
  directory: 'App directory or MCP listing',
  video: 'YouTube or video',
  forum: 'Reddit or forum',
  other: 'Other (free text)',
  dismissed: 'Dismissed',
};

export function heardAboutLabel(answer: string): string {
  return LABELS[answer] ?? answer;
}

export function HeardAboutTile({ rows }: { rows: GrowthHeardAboutRow[] }) {
  const answered = rows.filter((row) => row.answer !== 'dismissed');
  const total = rows.reduce((sum, row) => sum + row.workspaces, 0);
  const answeredTotal = answered.reduce((sum, row) => sum + row.workspaces, 0);
  const ordered = [...answered].sort((a, b) => b.workspaces - a.workspaces || b.paid - a.paid);
  const dismissed = rows.find((row) => row.answer === 'dismissed');
  if (dismissed) ordered.push(dismissed);
  return (
    <Tile label="Where they heard about us" aside="self-reported, all time">
      {total === 0 ? (
        <p className="bd-empty">Nobody has answered yet</p>
      ) : (
        <>
          <div className="bd-scroll">
            <table className="bd-table">
              <thead>
                <tr>
                  <th scope="col">Answer</th>
                  <th scope="col">Signups</th>
                  <th scope="col">Paid</th>
                  <th scope="col">Pay rate</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((row) => (
                  <tr key={row.answer} className={row.answer === 'dismissed' ? 'is-quiet' : undefined}>
                    <th scope="row" className="bd-cell-text">{heardAboutLabel(row.answer)}</th>
                    <td>{formatCount(row.workspaces)}</td>
                    <td>{formatCount(row.paid)}</td>
                    <td>{ratio(row.paid, row.workspaces)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="kiosk-big-caption">
            <strong>{ratio(answeredTotal, total)}</strong> of the workspaces asked chose an answer. Paid means a
            completed checkout. Internal accounts excluded.
          </p>
        </>
      )}
    </Tile>
  );
}
