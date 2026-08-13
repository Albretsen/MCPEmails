/**
 * Signup to first value: where new workspaces actually stop.
 *
 * Reads the durable `workspaces.onboarding_*_at` timestamps rather than
 * re-deriving stages from activity, so the funnel stays correct after
 * `activity_log` is purged at 90 days.
 *
 * Cohorted on signup date: every workspace counted at stage 1 is the same
 * population measured at stage 6, which is the only way a drop-off percentage
 * means anything.
 */

import { fetchActivationFunnel } from '@/lib/analytics/growth-queries';
import { FunnelBars } from '../charts';
import { SectionError, Section } from './shared';

const STAGE_LABELS: Record<string, string> = {
  signup: 'Signed up',
  client_selected: 'Picked an MCP client',
  inbox_connected: 'Connected an inbox',
  connection_verified: 'Connection verified',
  credential_issued: 'Got an API key',
  technical_activation: 'First successful tool call',
  value_activation: 'First mailbox operation',
};

export async function ActivationFunnelSection({ days }: { days: number }) {
  const result = await fetchActivationFunnel(days);
  if (!result.ok) return <SectionError title="Signup to first value" message={result.error} />;

  const steps = [...result.data]
    .sort((a, b) => a.stage_index - b.stage_index)
    .map((row) => ({ label: STAGE_LABELS[row.stage] ?? row.stage, value: row.workspaces }));

  return (
    <Section
      title="Signup to first value"
      blurb={`Workspaces created in the last ${days} days, measured against where they got to. Stages are cumulative: a workspace that reached a later stage counts at every earlier one, so the funnel can only narrow.`}
    >
      <div className="growth-panel">
        <FunnelBars title={`Workspaces created in the last ${days} days`} steps={steps} />
      </div>
      <p className="growth-note">
        Value activation is the stage that matters: a successful call that touched a mailbox.
        Everything before it proves only that the plumbing works.
      </p>
      <p className="growth-note">
        <strong>Read the middle stages with care.</strong> Client selection and connection verification were
        only instrumented on 2026-08-05. For workspaces created before that, the 20260805010000 backfill set
        late timestamps without earlier ones, so those two stages are inferred from the stage that follows
        them and carry no independent signal. Only 11 workspaces genuinely have a recorded client selection.
        The funnel is fully trustworthy for windows that start after 2026-08-05.
      </p>
    </Section>
  );
}
