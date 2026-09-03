/**
 * /admin/growth/experiments: run the A/B experiments from a page, not a SQL
 * client.
 *
 * THE WHOLE PAGE IS SERVER-RENDERED HTML AND PLAIN FORMS. There is no 'use
 * client' here and no fetch from the browser. Every mutation is a
 * <form method="post"> pointing at a route handler that does the work and
 * answers 303 back to this URL, so the next render re-reads the database and
 * the screen can never disagree with it. That is the same pattern the Refresh
 * button on /admin/growth uses, and it exists because Server Actions failed
 * their action-ID lookup in production on this app.
 *
 * WHAT THIS PAGE REFUSES TO DO. It does not print a p-value, a confidence
 * interval, or the word significant. With this much traffic none of those
 * would be honest, and a number that looks like statistics invites a decision
 * that the sample cannot support. What it prints instead is counts, and a
 * percentage only once a denominator has cleared MIN_DENOMINATOR_FOR_PERCENT,
 * which is the same honesty rule every chart on the growth board follows.
 *
 * The owner override is deliberately separated from everything else on the
 * page: it changes what THIS browser sees and is never recorded as an
 * assignment, so looking at your own variant cannot pollute the result.
 */

import { requireAdmin } from '@/lib/admin/require-admin';
import { fetchExperimentStats, listExperiments } from '@/lib/experiments/admin';
import { getExperimentDecisionForRequest, getOwnerOverrides } from '@/lib/experiments/request';
import type {
  ExperimentRecord,
  ExperimentVariantStats,
  RetentionGoal,
  VariantDecision,
} from '@/lib/experiments/constants';
import { MIN_DENOMINATOR_FOR_PERCENT, formatCount, ratio } from '../../../../components/admin/charts/format';
import '../../../../styles/admin-board.css';
import '../../../../styles/admin-experiments.css';

export const metadata = { title: 'Experiments · MCP Emails', robots: { index: false, follow: false } };

/** Assignments and stats change on every visitor, so nothing here is cached. */
export const dynamic = 'force-dynamic';

const PAGE_PATH = '/admin/growth/experiments';

/**
 * The retention goal, in the words of what actually gets counted. The panel
 * states this next to every retention number because "retained" is the figure
 * on this page most likely to be read as something it is not.
 */
const GOAL_WORDS: Record<RetentionGoal, string> = {
  mailbox_activity: 'real mailbox work (a successful tool call on a connected inbox, not inbox_list) on a later day',
  any_tool_call: 'any tool call on a later day',
  value_activation: 'reached value activation',
};

const GOAL_OPTIONS: { value: RetentionGoal; label: string }[] = [
  { value: 'mailbox_activity', label: 'Real mailbox work on a later day' },
  { value: 'any_tool_call', label: 'Any tool call on a later day' },
  { value: 'value_activation', label: 'Reached value activation' },
];

/** Why the current browser is seeing what it is seeing, said in one clause. */
const REASON_WORDS: Record<VariantDecision['reason'], string> = {
  winner: 'this experiment is concluded and everyone gets the winner',
  override: 'your own override, which is not counted',
  draft: 'the experiment is a draft, so everyone gets the control',
  assigned: 'you were bucketed by the public split',
  unknown: 'the experiment could not be read, so this is the fallback',
};

/**
 * Dates on this page are facts about rows, not a series. Day precision is
 * enough. A missing date prints "not yet" rather than format.ts's NO_DATA
 * marker, which is the one glyph this repo does not type.
 */
function day(value: string | null): string {
  if (!value) return 'not yet';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'not yet';
  return parsed.toISOString().slice(0, 10);
}

/**
 * ratio() with the empty marker taken out. An experiment nobody has reached
 * yet divides by zero on every row, and "0 of 0" says that plainly where a
 * dash would just look like a rendering fault.
 */
function rate(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return `${formatCount(Number.isFinite(numerator) ? numerator : 0)} of ${formatCount(Number.isFinite(denominator) ? denominator : 0)}`;
  }
  return ratio(numerator, denominator);
}

function statsFor(stats: ExperimentVariantStats[], variantId: string): ExperimentVariantStats {
  return (
    stats.find((row) => row.variant_id === variantId) ?? {
      variant_id: variantId,
      assigned: 0,
      signed_up: 0,
      converted: 0,
      retention_eligible: 0,
      retained: 0,
    }
  );
}

function labelFor(experiment: ExperimentRecord, variantId: string | null): string {
  if (!variantId) return 'none';
  return experiment.variants.find((variant) => variant.id === variantId)?.label ?? variantId;
}

type Loaded = {
  experiment: ExperimentRecord;
  stats: ExperimentVariantStats[];
  decision: VariantDecision;
};

function StatusPill({ status }: { status: ExperimentRecord['status'] }) {
  return <span className={`xp-pill xp-pill-${status}`}>{status}</span>;
}

/**
 * The results table plus the weight editor, which are one form because the
 * weights sit in a column of it. The sum is computed here, on the server, from
 * the STORED weights: without client JavaScript the page cannot report what
 * the operator has typed but not yet saved, and pretending otherwise would be
 * worse than saying nothing.
 */
function Results({ experiment, stats }: { experiment: ExperimentRecord; stats: ExperimentVariantStats[] }) {
  const sum = experiment.variants.reduce((total, variant) => total + variant.weight, 0);
  const widestSignup = experiment.variants.reduce(
    (widest, variant) => Math.max(widest, statsFor(stats, variant.id).signed_up),
    0,
  );
  const tooSmall = widestSignup < MIN_DENOMINATOR_FOR_PERCENT;
  const days = experiment.retention_window_days;

  return (
    <form method="post" action={`${PAGE_PATH}/${experiment.key}/update`}>
      <input type="hidden" name="intent" value="weights" />
      <div className="ac-scroll">
        <table className="ac-table xp-table">
          <thead>
            <tr>
              <th scope="col">Variant</th>
              <th scope="col" className="xp-col-weight">Weight</th>
              <th scope="col">Assigned</th>
              <th scope="col">Signed up</th>
              <th scope="col">Converted</th>
              <th scope="col">Conversion</th>
              <th scope="col">Retention eligible</th>
              <th scope="col">Retained</th>
              <th scope="col">Retention</th>
            </tr>
          </thead>
          <tbody>
            {experiment.variants.map((variant, index) => {
              const row = statsFor(stats, variant.id);
              return (
                <tr key={variant.id}>
                  <th scope="row">
                    {variant.label}
                    {index === 0 ? <span className="xp-control-tag">control</span> : null}
                  </th>
                  <td className="xp-cell-weight">
                    <label>
                      <span className="ac-visually-hidden">{`Weight for ${variant.label}`}</span>
                      <input
                        className="xp-weight"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        name={`weight_${variant.id}`}
                        defaultValue={variant.weight}
                      />
                    </label>
                  </td>
                  <td>{formatCount(row.assigned)}</td>
                  <td>{formatCount(row.signed_up)}</td>
                  <td>{formatCount(row.converted)}</td>
                  <td>{rate(row.converted, row.signed_up)}</td>
                  <td>{formatCount(row.retention_eligible)}</td>
                  <td>{formatCount(row.retained)}</td>
                  <td>{rate(row.retained, row.retention_eligible)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="xp-sum">
        <span>
          Sum: <b className={sum === 100 ? undefined : 'xp-sum-bad'}>{sum}</b>
        </span>
        {sum === 100 ? null : <span className="xp-sum-bad">Weights must add up to 100 before this saves.</span>}
        <button type="submit" className="xp-btn">Save weights</button>
      </p>

      <p className="xp-note">
        {tooSmall
          ? 'Fewer than 10 sign-ups per variant so far. Counts are shown instead of rates and nothing here is a result yet.'
          : 'Rates are plain counts divided by sign-ups. With samples this size a few people moving changes the picture, so read the counts, not the decimals.'}
      </p>
      <p className="xp-note">
        {`Retention counts ${GOAL_WORDS[experiment.retention_goal]} within ${days} days of signup; only accounts older than ${days} days are eligible.`}
      </p>
    </form>
  );
}

/** Start, pause, reopen, and conclude. Whichever of them the status allows. */
function Controls({ experiment }: { experiment: ExperimentRecord }) {
  const action = `${PAGE_PATH}/${experiment.key}/update`;
  return (
    <div className="xp-block">
      <h3>Status</h3>
      <div className="xp-controls">
        {experiment.status === 'draft' ? (
          <form method="post" action={action}>
            <input type="hidden" name="intent" value="start" />
            <button type="submit" className="xp-btn xp-btn-primary">Start the split</button>
          </form>
        ) : null}
        {experiment.status === 'running' ? (
          <form method="post" action={action}>
            <input type="hidden" name="intent" value="pause" />
            <button type="submit" className="xp-btn">Pause, keeping assignments</button>
          </form>
        ) : null}
        {experiment.status === 'concluded' ? (
          <form method="post" action={action}>
            <input type="hidden" name="intent" value="reopen" />
            <button type="submit" className="xp-btn">Reopen and split again</button>
          </form>
        ) : null}
        {/* Only a running experiment can be concluded. Declaring a winner for a
            draft would be declaring a winner of a split that never happened,
            and lib/experiments/admin.ts refuses the transition. */}
        {experiment.status === 'running' ? (
          <form method="post" action={action}>
            <input type="hidden" name="intent" value="conclude" />
            <label className="xp-field">
              <span>Winner</span>
              <select name="winner_variant_id" defaultValue={experiment.variants[0]?.id ?? ''}>
                {experiment.variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>{variant.label}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="xp-btn">Declare winner and lock</button>
            <span className="xp-hint">After concluding, every visitor gets the winner and the split stops.</span>
          </form>
        ) : null}
      </div>
      {experiment.status === 'concluded' ? (
        <p className="xp-hint">{`Locked to ${labelFor(experiment, experiment.winner_variant_id)}. Every visitor gets it, and no new assignments are recorded.`}</p>
      ) : null}
    </div>
  );
}

/** Name, description, goal and window. The slow-moving half of an experiment. */
function Details({ experiment }: { experiment: ExperimentRecord }) {
  return (
    <div className="xp-block">
      <h3>Details</h3>
      <form method="post" action={`${PAGE_PATH}/${experiment.key}/update`} className="xp-row">
        <input type="hidden" name="intent" value="details" />
        <label className="xp-field xp-field-wide">
          <span>Name</span>
          <input type="text" name="name" defaultValue={experiment.name} maxLength={120} required />
        </label>
        <label className="xp-field xp-field-wide">
          <span>Description</span>
          <input type="text" name="description" defaultValue={experiment.description ?? ''} maxLength={500} />
        </label>
        <label className="xp-field">
          <span>Retention goal</span>
          <select name="retention_goal" defaultValue={experiment.retention_goal}>
            {GOAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="xp-field">
          <span>Window (days)</span>
          <input type="number" name="retention_window_days" min="1" max="90" step="1" defaultValue={experiment.retention_window_days} />
        </label>
        <button type="submit" className="xp-btn">Save details</button>
      </form>
      <p className="xp-hint">
        {`Counted right now: ${GOAL_WORDS[experiment.retention_goal]}, inside ${experiment.retention_window_days} days of signup. Activity older than 90 days is purged, which is why the window stops there.`}
      </p>
    </div>
  );
}

/** The override is a cookie on this browser. It is never an assignment. */
function Override({ experiment, current }: { experiment: ExperimentRecord; current: string | undefined }) {
  return (
    <div className="xp-block">
      <h3>Your own view</h3>
      <form method="post" action={`${PAGE_PATH}/override`} className="xp-row">
        <input type="hidden" name="key" value={experiment.key} />
        <label className="xp-field">
          <span>Pin this browser to</span>
          <select name="variant_id" defaultValue={current ?? ''}>
            <option value="">Follow the public split</option>
            {experiment.variants.map((variant) => (
              <option key={variant.id} value={variant.id}>{variant.label}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="xp-btn">Apply</button>
        <span className="xp-hint">This only changes what your browser sees and is never counted.</span>
      </form>
      <p className="xp-hint">{current ? `Your override: ${labelFor(experiment, current)}` : 'No override'}</p>
    </div>
  );
}

function ExperimentCard({ loaded, override }: { loaded: Loaded; override: string | undefined }) {
  const { experiment, stats, decision } = loaded;
  return (
    <article className="ac-card xp-card" id={experiment.key}>
      <div className="xp-head">
        <div>
          <h2>
            {experiment.name}
            <code className="xp-key">{experiment.key}</code>
          </h2>
          {experiment.description ? <p className="xp-desc">{experiment.description}</p> : null}
        </div>
        <StatusPill status={experiment.status} />
      </div>

      <p className="xp-dates">
        <span><b>Created:</b> {day(experiment.created_at)}</span>
        <span><b>Started:</b> {day(experiment.started_at)}</span>
        <span><b>Concluded:</b> {day(experiment.concluded_at)}</span>
      </p>

      <p className="xp-seeing">
        <span className="xp-seeing-text">
          You are seeing: <b>{labelFor(experiment, decision.variantId)}</b> <span>({REASON_WORDS[decision.reason]})</span>
        </span>
        <a href={`/api/admin/experiments/${experiment.key}/preview`}>Preview as JSON</a>
      </p>

      <Results experiment={experiment} stats={stats} />
      <Controls experiment={experiment} />
      <Details experiment={experiment} />
      <Override experiment={experiment} current={override} />
    </article>
  );
}

/** Four rows, because four variants is already more than this traffic can read. */
const CREATE_ROWS = [
  { id: 'control', label: 'Control', weight: '100' },
  { id: '', label: '', weight: '' },
  { id: '', label: '', weight: '' },
  { id: '', label: '', weight: '' },
];

function CreateForm() {
  return (
    <article className="ac-card xp-card">
      <div className="xp-head">
        <h2>New experiment</h2>
      </div>
      <form method="post" action={`${PAGE_PATH}/create`} className="xp-create-grid">
        <div className="xp-row">
          <label className="xp-field">
            <span>Key</span>
            <input
              type="text"
              name="key"
              required
              pattern="[a-z0-9_]{2,64}"
              placeholder="pricing_headline"
              title="Lower case letters, digits and underscores, 2 to 64 characters."
            />
          </label>
          <label className="xp-field xp-field-wide">
            <span>Name</span>
            <input type="text" name="name" required maxLength={120} placeholder="Pricing headline" />
          </label>
        </div>
        <label className="xp-field xp-field-wide">
          <span>Description</span>
          <textarea name="description" maxLength={500} placeholder="What each variant changes, and what you expect to happen." />
        </label>
        <div className="xp-row">
          <label className="xp-field">
            <span>Retention goal</span>
            <select name="retention_goal" defaultValue="mailbox_activity">
              {GOAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="xp-field">
            <span>Window (days)</span>
            <input type="number" name="retention_window_days" min="1" max="90" step="1" defaultValue="7" />
          </label>
        </div>

        <h3 className="xp-block-title">Variants</h3>
        {CREATE_ROWS.map((row, index) => (
          <div className="xp-variant-row" key={index}>
            <label className="xp-field xp-variant-id">
              <span>{`Variant ${index + 1} id`}</span>
              <input type="text" name="variant_id[]" defaultValue={row.id} pattern="[a-z0-9_]{1,32}" placeholder="video" />
            </label>
            <label className="xp-field xp-variant-label">
              <span>Label</span>
              <input type="text" name="variant_label[]" defaultValue={row.label} maxLength={120} placeholder="Homepage with demo video" />
            </label>
            <label className="xp-field xp-variant-weight">
              <span>Weight</span>
              <input type="number" name="variant_weight[]" min="0" max="100" step="1" defaultValue={row.weight} />
            </label>
          </div>
        ))}

        <p className="xp-hint">
          Rows with no id are ignored. The first variant is the control: it is what every visitor gets while the
          experiment is a draft. Weights are whole numbers that add up to 100.
        </p>
        <div>
          <button type="submit" className="xp-btn xp-btn-primary">Create as a draft</button>
        </div>
      </form>
    </article>
  );
}

export default async function ExperimentsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const experiments = await listExperiments();
  const overrides = await getOwnerOverrides();
  const loaded: Loaded[] = await Promise.all(
    experiments.map(async (experiment) => ({
      experiment,
      stats: await fetchExperimentStats(experiment.key),
      decision: await getExperimentDecisionForRequest(experiment.key),
    })),
  );

  return (
    <main className="board">
      <header className="bd-head">
        <div>
          <h1>Experiments</h1>
          <p className="bd-head-sub">
            Anonymous visitors are bucketed once and stay put. Counts come from the product database. UTC.
          </p>
        </div>
        <div className="bd-tools">
          <a href="/admin/growth">Growth</a>
          <a href="/admin/growth/kiosk">Kiosk</a>
        </div>
      </header>

      {params.error ? (
        <p className="xp-banner xp-banner-error" role="alert">{params.error}</p>
      ) : null}
      {params.ok ? (
        <p className="xp-banner xp-banner-ok">{`Saved: ${params.ok}.`}</p>
      ) : null}

      <div className="xp-list">
        {loaded.length === 0 ? (
          <p className="xp-empty">No experiments yet. Create one below.</p>
        ) : (
          loaded.map((entry) => (
            <ExperimentCard
              key={entry.experiment.key}
              loaded={entry}
              override={overrides[entry.experiment.key]}
            />
          ))
        )}
        <CreateForm />
      </div>

      <p className="bd-foot">
        Nothing on this page is a statistical test. Read the counts. A variant wins when it is ahead by an amount
        that would still look like a difference if a handful of people had gone the other way.
      </p>
    </main>
  );
}
