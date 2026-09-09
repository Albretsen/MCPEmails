/**
 * /admin/growth/users/[id]: one person, end to end.
 *
 * WHAT IT IS FOR. Six tables record what happened to a customer -- users,
 * workspaces, inboxes, api_keys, product_funnel_events, usage_limit_events,
 * and the two email logs -- no two of them name their timestamp column the same
 * way, and the story only reads in one order. Assembling that by hand takes
 * several minutes and a lot of copied uuids, which is why it was never done
 * twice for the same person.
 *
 * ONE SUSPENSE BOUNDARY PER BAND, the same rule as the growth board: per panel
 * would assemble the page in a dozen visible steps, one for the page would hold
 * everything behind the slowest read. Nothing here throws -- every fetcher
 * returns a GrowthResult and a failure becomes a visibly dead panel rather than
 * a missing one, because a hole in a page of counts reads as a zero.
 *
 * THE HEADER FIGURES COME FROM THE SAME RPC THE LIST USES, filtered to one id.
 * A second query with its own arithmetic is how a detail page ends up quietly
 * disagreeing with the row that linked to it.
 */

import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/admin/require-admin';
import {
  fetchUserActivity,
  fetchUserErrors,
  fetchUserInboxes,
  fetchUserRow,
  fetchUserTimeline,
  fetchUserTools,
  fetchUserWorkspaces,
  USER_WINDOW_DAYS,
} from '@/lib/analytics/user-directory';
import { Dead } from '../../../../../components/admin/growth/Dead';
import { Chrome } from '../../../../../components/admin/users/chrome';
import {
  Acquisition,
  BackLink,
  Billing,
  Errors,
  Headline,
  Identity,
  Inboxes,
  Journey,
  Panel,
  Timeline,
  Tools,
  Volume,
  Workspaces,
} from '../../../../../components/admin/users/detail';
import '../../../../../styles/admin-board.css';
import '../../../../../styles/admin-charts.css';
import '../../../../../styles/admin-kiosk.css';
import '../../../../../styles/admin-growth.css';
import '../../../../../styles/admin-users.css';

export const metadata = { title: 'Person · MCP Emails', robots: { index: false, follow: false } };

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  // A malformed id would reach Postgres as an invalid uuid and come back as a
  // dead panel saying so, which is a worse 404 than a 404.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  return (
    <div className="gb us us-detail">
      <main className="gb-inner">
        <Chrome trail={<><BackLink /><span className="us-crumb is-current">Person</span></>} />
        <Suspense fallback={<p className="us-loading">Reading the account…</p>}>
          <Head id={id} />
        </Suspense>
        <Suspense fallback={<p className="us-loading">Reading workspaces and mailboxes…</p>}>
          <Owned id={id} />
        </Suspense>
        <Suspense fallback={<p className="us-loading">Reading usage…</p>}>
          <Usage id={id} />
        </Suspense>
        <Suspense fallback={<p className="us-loading">Reading the history…</p>}>
          <History id={id} />
        </Suspense>

        <p className="gb-foot">
          Calls, days, the success rate and every per-tool figure are counted over the last {USER_WINDOW_DAYS}{' '}
          days, because <code>activity_log</code> is purged there; every dated event below is durable and
          all-time. Usage is attributed to the workspace OWNER, so a seat on somebody else&rsquo;s workspace
          contributes nothing here. No credential, token, message content, subject, recipient, IP address or
          user agent appears on this page. UTC throughout, cached ten minutes.
        </p>
      </main>
    </div>
  );
}

async function Head({ id }: { id: string }) {
  const result = await fetchUserRow(id, USER_WINDOW_DAYS);
  if (!result.ok) return <Dead what="The account" error={result.error} />;
  if (!result.data) notFound();
  const row = result.data;
  return (
    <>
      <Identity row={row} />
      <Headline row={row} windowDays={USER_WINDOW_DAYS} />
      <div className="us-bands">
        <Panel title="Journey" sub="Every rung, and the wait between them" wide>
          <Journey row={row} />
        </Panel>
        <Panel title="Where they came from" sub="Recorded on the workspace created at signup">
          <Acquisition row={row} />
        </Panel>
        <Panel title="Money and access">
          <Billing row={row} />
        </Panel>
      </div>
    </>
  );
}

async function Owned({ id }: { id: string }) {
  const [workspaces, inboxes] = await Promise.all([
    fetchUserWorkspaces(id, USER_WINDOW_DAYS),
    fetchUserInboxes(id, USER_WINDOW_DAYS),
  ]);
  return (
    <div className="us-bands is-stacked">
      <Panel title="Workspaces" sub="Owned and joined, deleted ones included" wide>
        {workspaces.ok ? <Workspaces rows={workspaces.data} /> : <Dead what="The workspace list" error={workspaces.error} />}
      </Panel>
      <Panel title="Mailboxes" sub="Every mailbox ever connected under a workspace they own" wide>
        {inboxes.ok ? <Inboxes rows={inboxes.data} /> : <Dead what="The mailbox list" error={inboxes.error} />}
      </Panel>
    </div>
  );
}

async function Usage({ id }: { id: string }) {
  const [activity, tools, errors] = await Promise.all([
    fetchUserActivity(id, USER_WINDOW_DAYS),
    fetchUserTools(id, USER_WINDOW_DAYS),
    fetchUserErrors(id, USER_WINDOW_DAYS),
  ]);
  return (
    <div className="us-bands is-stacked">
      <Panel title="Volume" wide>
        {activity.ok ? (
          <Volume rows={activity.data} windowDays={USER_WINDOW_DAYS} />
        ) : (
          <Dead what="The daily volume" error={activity.error} />
        )}
      </Panel>
      <div className="us-bands">
        <Panel title="What they use" sub={`Busiest first, last ${USER_WINDOW_DAYS} days`}>
          {tools.ok ? <Tools rows={tools.data} windowDays={USER_WINDOW_DAYS} /> : <Dead what="The tool mix" error={tools.error} />}
        </Panel>
        <Panel title="What is broken" sub="Failures by code and tool">
          {errors.ok ? <Errors rows={errors.data} windowDays={USER_WINDOW_DAYS} /> : <Dead what="The error list" error={errors.error} />}
        </Panel>
      </div>
    </div>
  );
}

async function History({ id }: { id: string }) {
  const timeline = await fetchUserTimeline(id);
  return (
    <div className="us-bands is-stacked">
      <Panel
        title="Everything that happened"
        sub="Signup, workspaces, mailboxes, keys, funnel attempts, cap rejections and the emails we sent"
        wide
      >
        {timeline.ok ? <Timeline rows={timeline.data} /> : <Dead what="The timeline" error={timeline.error} />}
      </Panel>
    </div>
  );
}
