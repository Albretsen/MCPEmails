/**
 * A row of large numbers for the test read-out bands: the label, the number,
 * one short line of context, and whether it meets its bar.
 */

type State = 'pass' | 'fail' | 'wait';

const STATE_WORDS: Record<State, string> = { pass: 'Pass', fail: 'Fail', wait: 'Waiting' };

export type BigStat = {
  label: string;
  value: string;
  note?: string;
  state?: State;
  /** A word in place of the state, such as a test verdict. */
  word?: { text: string; tone: 'good' | 'warn' | 'bad' | 'quiet' };
};

export function BigStats({ stats }: { stats: BigStat[] }) {
  return (
    <div className="gb-big" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
      {stats.map((stat) => (
        <div key={stat.label} className="gb-big-stat">
          <p className="gb-big-label">{stat.label}</p>
          <p className="gb-big-value">{stat.value}</p>
          {stat.note && <p className="gb-big-note">{stat.note}</p>}
          {stat.word ? (
            <p className={`gb-big-state is-${stat.word.tone}`}>{stat.word.text}</p>
          ) : (
            stat.state && <p className={`gb-big-state is-${stat.state}`}>{STATE_WORDS[stat.state]}</p>
          )}
        </div>
      ))}
    </div>
  );
}
