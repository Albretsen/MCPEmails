'use client';

import { useState, useEffect } from 'react';
import { Icon, Badge, Btn, Avatar, ProviderLogo } from '../Primitives';
import { useToast } from './Toast';

/* Pages.jsx — Overview, Inboxes, Keys, Usage, Settings, Security. */

function PageHeader({ title, sub, action }) {
  return (
    <div className="page-header">
      <div className="grow">
        <div className="page-title">{title}</div>
        {sub ? <div className="page-sub">{sub}</div> : null}
      </div>
      {action || null}
    </div>
  );
}

/* ── GettingStartedGuide ──────────────────────────────────────────────────── */

/**
 * Single step row inside the getting-started guide.
 * When `done` is true the step number is replaced by a mint check icon and the
 * row is visually de-emphasised so the user's eye is drawn to pending steps.
 */
function GettingStartedStep({ num, done, title, desc, action }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 14,
      padding: '14px 16px',
      background: done ? 'var(--bg-page)' : 'var(--bg-sunken)',
      borderRadius: 10,
      border: '1px solid var(--border-1)',
      opacity: done ? 0.6 : 1,
      transition: 'opacity var(--dur-2) var(--ease-out)',
    }}>
      {/* Step indicator */}
      <div style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        background: done ? 'var(--live-soft)' : 'var(--brand-soft)',
        border: `1px solid ${done ? 'rgba(31,203,139,0.28)' : 'rgba(37,71,229,0.2)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 700,
        color: done ? 'var(--mint-600)' : 'var(--brand)',
        transition: 'all var(--dur-2) var(--ease-out)',
      }}>
        {done ? <Icon name="check" size={12} color="var(--mint-600)" /> : num}
      </div>

      {/* Copy */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          fontWeight: 600,
          color: done ? 'var(--fg-3)' : 'var(--fg-1)',
        }}>
          {title}
        </div>
        <div style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 12.5,
          color: 'var(--fg-3)',
          marginTop: 2,
          lineHeight: 1.5,
        }}>
          {desc}
        </div>
      </div>

      {/* CTA — hidden once this step is done */}
      {!done && action ? (
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {action}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Getting-started guide shown on the Overview page when the workspace has
 * no inboxes or no API keys (i.e. the account is still being set up).
 * Each step can be marked `done` so users see progress as they complete steps.
 */
function GettingStartedGuide({ inboxCount, apiKeysCount, onConnect, onGoToKeys }) {
  const step1Done = inboxCount > 0;
  const step2Done = apiKeysCount > 0;
  const allDone   = step1Done && step2Done;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <div>
          <div className="title">Get started</div>
          <div className="sub">
            {allDone
              ? 'All set — your workspace is ready to use.'
              : 'Three steps to give your AI agents live email access.'}
          </div>
        </div>
        {allDone && <Badge tone="live" dot="live">Ready</Badge>}
      </div>
      <div style={{ padding: '4px 20px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <GettingStartedStep
          num={1}
          done={step1Done}
          title="Connect an inbox"
          desc="Give your agents access to Gmail, Outlook, or any IMAP mailbox."
          action={
            <Btn variant="primary" size="sm" icon="plus" onClick={onConnect}>
              Connect inbox
            </Btn>
          }
        />
        <GettingStartedStep
          num={2}
          done={step2Done}
          title="Create an API key"
          desc="Generate a bearer token so your MCP client can authenticate with the server."
          action={
            <Btn variant="secondary" size="sm" icon="key" onClick={onGoToKeys}>
              Create API key
            </Btn>
          }
        />
        <GettingStartedStep
          num={3}
          done={allDone}
          title="Connect your MCP client"
          desc="Point Claude Desktop or any MCP client at the endpoint URL with your API key."
          action={
            <a
              href="/docs"
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12.5,
                color: 'var(--brand)',
                textDecoration: 'none',
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              View docs →
            </a>
          }
        />
      </div>
    </div>
  );
}

/* ---------------- Overview ---------------- */
export function OverviewPage({ inboxes, activity, stats, planLimits, onConnect, onGoToKeys }) {
  const inboxCount = stats?.inboxCount ?? 0;
  const apiKeysCount = stats?.apiKeysCount ?? 0;
  const callsToday = stats?.callsToday ?? 0;
  const callsThisMonth = stats?.callsThisMonth ?? 0;

  // Plan daily burst cap — null means unlimited (Enterprise or unknown).
  const dailyCap = planLimits?.maxDailyBurstCalls ?? null;
  const dailyPct = dailyCap != null && dailyCap > 0 ? callsToday / dailyCap : 0;
  // Warn at ≥80%, block at 100%.
  const dailyAtLimit = dailyCap != null && callsToday >= dailyCap;
  const dailyNearLimit = !dailyAtLimit && dailyCap != null && dailyPct >= 0.8;

  // Plan monthly call cap — null means unlimited (Enterprise or unknown).
  const monthlyCap = planLimits?.maxMonthlyToolCalls ?? null;
  const monthlyPct = monthlyCap != null && monthlyCap > 0 ? callsThisMonth / monthlyCap : 0;
  const monthlyAtLimit = monthlyCap != null && callsThisMonth >= monthlyCap;
  const monthlyNearLimit = !monthlyAtLimit && monthlyCap != null && monthlyPct >= 0.8;

  // Show the getting-started guide until both an inbox and an API key exist.
  const showGuide = inboxCount === 0 || apiKeysCount === 0;

  return (
    <div className="page">
      <PageHeader
        title="Overview"
        sub="Real-time view of your connected inboxes and MCP traffic."
        action={<Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>}
      />

      {/* Daily quota exhausted — red banner */}
      {dailyAtLimit && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          marginBottom: 12,
          background: 'var(--red-100, #fef2f2)',
          border: '1px solid rgba(229,72,77,0.25)',
          borderRadius: 10,
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          color: 'var(--red-700, #b91c1c)',
        }}>
          <Icon name="zap" size={15} color="var(--red-700, #b91c1c)" />
          <span style={{ flex: 1 }}>
            Your daily MCP call quota of {dailyCap.toLocaleString()} calls has been reached. New tool calls will be
            rejected until midnight UTC.{' '}
            <a href="/pricing" style={{ color: 'var(--red-700, #b91c1c)', fontWeight: 600 }}>
              Upgrade
            </a>{' '}
            for a higher limit.
          </span>
        </div>
      )}

      {/* Daily quota near limit — amber warning */}
      {dailyNearLimit && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          marginBottom: 12,
          background: 'var(--amber-50, #fffbeb)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 10,
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          color: 'var(--amber-800, #92400e)',
        }}>
          <Icon name="zap" size={15} color="var(--amber-600, #d97706)" />
          <span style={{ flex: 1 }}>
            You&rsquo;ve used {callsToday.toLocaleString()} of {dailyCap.toLocaleString()} daily calls ({Math.round(dailyPct * 100)}%).
            Quota resets at midnight UTC.{' '}
            <a href="/pricing" style={{ color: 'var(--amber-800, #92400e)', fontWeight: 600 }}>
              Upgrade
            </a>{' '}
            to avoid disruption.
          </span>
        </div>
      )}

      {/* Monthly quota exhausted — red banner */}
      {monthlyAtLimit && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          marginBottom: 12,
          background: 'var(--red-100, #fef2f2)',
          border: '1px solid rgba(229,72,77,0.25)',
          borderRadius: 10,
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          color: 'var(--red-700, #b91c1c)',
        }}>
          <Icon name="zap" size={15} color="var(--red-700, #b91c1c)" />
          <span style={{ flex: 1 }}>
            Your monthly quota of {monthlyCap.toLocaleString()} calls has been reached. Tool calls will be
            rejected until the start of next month.{' '}
            <a href="/pricing" style={{ color: 'var(--red-700, #b91c1c)', fontWeight: 600 }}>
              Upgrade
            </a>{' '}
            for a higher monthly limit.
          </span>
        </div>
      )}

      {/* Monthly quota near limit — amber warning */}
      {monthlyNearLimit && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          marginBottom: 12,
          background: 'var(--amber-50, #fffbeb)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: 10,
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          color: 'var(--amber-800, #92400e)',
        }}>
          <Icon name="zap" size={15} color="var(--amber-600, #d97706)" />
          <span style={{ flex: 1 }}>
            You&rsquo;ve used {callsThisMonth.toLocaleString()} of {monthlyCap.toLocaleString()} monthly calls ({Math.round(monthlyPct * 100)}%).
            Quota resets at the start of next month.{' '}
            <a href="/pricing" style={{ color: 'var(--amber-800, #92400e)', fontWeight: 600 }}>
              Upgrade
            </a>{' '}
            to avoid disruption.
          </span>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat">
          <div className="label">Inboxes connected</div>
          <div className="value">{inboxCount.toLocaleString()}</div>
          <div className="delta">{inboxCount === 1 ? "1 active inbox" : `${inboxCount} active inboxes`}</div>
        </div>
        <div className="stat">
          <div className="label">API keys</div>
          <div className="value">{apiKeysCount.toLocaleString()}</div>
          <div className="delta">{apiKeysCount === 1 ? "1 active key" : `${apiKeysCount} active keys`}</div>
        </div>
        <div className="stat">
          <div className="label">Calls today</div>
          <div className="value" style={dailyAtLimit ? { color: 'var(--red-600, #dc2626)' } : dailyNearLimit ? { color: 'var(--amber-600, #d97706)' } : {}}>
            {callsToday.toLocaleString()}
          </div>
          <div className="delta">
            {dailyCap != null
              ? `of ${dailyCap.toLocaleString()} daily limit · UTC day`
              : 'MCP tool calls (UTC day)'}
          </div>
          {/* Mini progress bar for daily quota */}
          {dailyCap != null && (
            <div style={{
              marginTop: 6,
              height: 3,
              borderRadius: 2,
              background: 'var(--bg-sunken, #f1f5f9)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, dailyPct * 100)}%`,
                background: dailyAtLimit
                  ? 'var(--red-500, #ef4444)'
                  : dailyNearLimit
                    ? 'var(--amber-500, #f59e0b)'
                    : 'var(--brand)',
                borderRadius: 2,
                transition: 'width 0.4s',
              }} />
            </div>
          )}
        </div>
        <div className="stat">
          <div className="label">Calls this month</div>
          <div className="value" style={monthlyAtLimit ? { color: 'var(--red-600, #dc2626)' } : monthlyNearLimit ? { color: 'var(--amber-600, #d97706)' } : {}}>
            {callsThisMonth.toLocaleString()}
          </div>
          <div className="delta">
            {monthlyCap != null
              ? `of ${monthlyCap.toLocaleString()} monthly limit · UTC month`
              : 'MCP tool calls (UTC month)'}
          </div>
          {/* Mini progress bar for monthly quota */}
          {monthlyCap != null && (
            <div style={{
              marginTop: 6,
              height: 3,
              borderRadius: 2,
              background: 'var(--bg-sunken, #f1f5f9)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, monthlyPct * 100)}%`,
                background: monthlyAtLimit
                  ? 'var(--red-500, #ef4444)'
                  : monthlyNearLimit
                    ? 'var(--amber-500, #f59e0b)'
                    : 'var(--brand)',
                borderRadius: 2,
                transition: 'width 0.4s',
              }} />
            </div>
          )}
        </div>
      </div>

      {showGuide ? (
        <GettingStartedGuide
          inboxCount={inboxCount}
          apiKeysCount={apiKeysCount}
          onConnect={onConnect}
          onGoToKeys={onGoToKeys}
        />
      ) : (
        <div className="overview-grid" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="card-h">
              <div>
                <div className="title">Calls per day</div>
                <div className="sub">Last 14 days · across all tools</div>
              </div>
              <div className="grow"></div>
              <Badge tone="brand">Pro</Badge>
            </div>
            <div className="card-body">
              <UsageBars />
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <div>
                <div className="title">Recent activity</div>
                <div className="sub">Live MCP tool calls</div>
              </div>
            </div>
            <div>
              {activity.length === 0 ? (
                <div className="empty" style={{ padding: '32px 20px' }}>
                  <div className="ico"><Icon name="activity" size={20} /></div>
                  <h3 style={{ fontSize: 14 }}>No activity yet</h3>
                  <p style={{ fontSize: 12.5 }}>MCP tool calls will appear here in real time.</p>
                </div>
              ) : (
                activity.map((a) => (
                  <div className="act-row" key={a.id ?? a.tool + a.time}>
                    <span className={"dot " + (a.ok ? "live" : "red")}></span>
                    <span className="tool">{a.tool}()</span>
                    <span className="meta">· {a.account}</span>
                    <span className="time">{a.time}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Formats a YYYY-MM-DD date string as "D Mon" — e.g. "24 May", "1 Jun".
 * Used for bar chart axis labels and stat card sub-labels.
 */
function formatBarDate(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = dateStr.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day, 10)} ${monthNames[parseInt(month, 10) - 1]}`;
}

/**
 * Compact bar chart used on the Overview page (14 hardcoded demo bars).
 * Replaced by UsageChart30 on the Usage page once real data is wired up.
 */
function UsageBars() {
  const data = [120, 168, 90, 210, 280, 305, 420, 388, 360, 480, 525, 612, 588, 640];
  const max = Math.max(...data);
  const labels = ["8 May","","","11","","","14","","","17","","","20","21"];
  return (
    <>
      <div className="bars">
        {data.map((v, i) => (
          <div key={i} className={"bar" + (i >= data.length - 4 ? " hot" : "")}
               style={{ height: (v / max * 100) + "%" }}
               title={v + " calls"}></div>
        ))}
      </div>
      <div className="bars-x">
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </>
  );
}

/**
 * 30-day bar chart that renders real daily call counts from `activity_log`.
 *
 * Props:
 *   dailyCounts — array of 30 { date: "YYYY-MM-DD", count: number } objects,
 *                 oldest first (index 0 = 29 days ago, index 29 = today).
 */
function UsageChart30({ dailyCounts }) {
  if (!dailyCounts || dailyCounts.length === 0) {
    return (
      <div style={{
        height: 160,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        color: 'var(--fg-3)',
      }}>
        No call data for this period.
      </div>
    );
  }

  const max = Math.max(...dailyCounts.map((d) => d.count), 1);
  const total = dailyCounts.length; // always 30

  // Show a date label every 5 bars; always show the last bar's label.
  const labels = dailyCounts.map((d, i) => {
    if (i === 0 || i % 5 === 4 || i === total - 1) return formatBarDate(d.date);
    return '';
  });

  return (
    <>
      <div className="bars bars-lg">
        {dailyCounts.map((d, i) => (
          <div
            key={d.date}
            className={'bar' + (i >= total - 7 ? ' hot' : '')}
            style={{ height: (d.count / max * 100) + '%' }}
            title={`${formatBarDate(d.date)} · ${d.count.toLocaleString()} call${d.count !== 1 ? 's' : ''}`}
          />
        ))}
      </div>
      <div className="bars-x">
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </>
  );
}

/* ---------------- Inboxes ---------------- */
export function InboxesPage({ inboxes, planLimits, onConnect, onRemove, onReconnect }) {
  // Count errored inboxes to conditionally show a page-level warning banner.
  const erroredCount = inboxes.filter(ib => ib.status === "error").length;

  // Determine if the workspace is at its inbox cap.
  const maxInboxes = planLimits?.maxInboxes ?? null; // null = unlimited
  const atInboxLimit = maxInboxes !== null && inboxes.length >= maxInboxes;
  // inbox object pending disconnect confirmation, or null
  const [confirmInbox, setConfirmInbox] = useState(null);
  // true while the DELETE API call is in flight
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnectRequest = (inbox) => {
    setConfirmInbox(inbox);
  };

  const handleDisconnectCancel = () => {
    if (!disconnecting) setConfirmInbox(null);
  };

  const handleDisconnectConfirm = async () => {
    if (!confirmInbox || disconnecting) return;
    setDisconnecting(true);
    try {
      await onRemove(confirmInbox.id);
      // onRemove resolves on success; App.jsx handles state update and toast.
      setConfirmInbox(null);
    } catch {
      // onRemove rejects on API error; App.jsx already showed an error toast.
      // Leave the dialog open so the user sees the inbox is still connected.
    } finally {
      setDisconnecting(false);
    }
  };

  // Build the connect-inbox action element based on plan limit state.
  const connectAction = atInboxLimit ? (
    <a
      href="/pricing"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 14px',
        height: 34,
        background: 'var(--brand)',
        color: '#fff',
        borderRadius: 8,
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: 500,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon name="zap" size={13} color="#fff" />
      Upgrade plan
    </a>
  ) : (
    <Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>
  );

  return (
    <div className="page">
      <PageHeader
        title="Inboxes"
        sub={
          maxInboxes !== null
            ? `${inboxes.length} of ${maxInboxes} inbox${maxInboxes !== 1 ? 'es' : ''} connected · ${planLimits ? '' : ''}Email accounts your agents can read and send through.`
            : 'Email accounts your agents can read and send through.'
        }
        action={connectAction}
      />

      {/* Plan inbox limit banner — shown when at cap */}
      {atInboxLimit && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          marginBottom: 12,
          background: 'var(--brand-soft)',
          border: '1px solid rgba(37,71,229,0.2)',
          borderRadius: 10,
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          color: 'var(--brand)',
        }}>
          <Icon name="zap" size={15} color="var(--brand)" />
          <span style={{ flex: 1 }}>
            You&rsquo;ve reached your plan&rsquo;s inbox limit ({maxInboxes} inbox{maxInboxes !== 1 ? 'es' : ''}).{' '}
            <a href="/pricing" style={{ color: 'var(--brand)', fontWeight: 600 }}>
              Upgrade
            </a>{' '}
            to connect more.
          </span>
        </div>
      )}

      {/* Plan usage indicator — shown when not at limit but limit exists */}
      {!atInboxLimit && maxInboxes !== null && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
          fontFamily: 'var(--font-sans)',
          fontSize: 12.5,
          color: 'var(--fg-3)',
        }}>
          <div style={{
            width: 80,
            height: 4,
            background: 'var(--bg-sunken)',
            borderRadius: 2,
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.min(100, (inboxes.length / maxInboxes) * 100)}%`,
              background: inboxes.length / maxInboxes >= 0.8 ? 'var(--amber-500, #f59e0b)' : 'var(--brand)',
              borderRadius: 2,
              transition: 'width 0.3s',
            }} />
          </div>
          <span>{inboxes.length} of {maxInboxes} inbox{maxInboxes !== 1 ? 'es' : ''} used</span>
        </div>
      )}

      {/* Banner shown when one or more inboxes need reconnection */}
      {erroredCount > 0 && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          marginBottom: 12,
          background: "var(--red-100)",
          border: "1px solid rgba(229,72,77,0.25)",
          borderRadius: 10,
          fontFamily: "var(--font-sans)",
          fontSize: 13.5,
          color: "var(--red-700)",
        }}>
          <Icon name="zap" size={15} color="var(--red-700)" />
          <span>
            {erroredCount === 1
              ? "1 inbox has lost access and needs to be reconnected."
              : `${erroredCount} inboxes have lost access and need to be reconnected.`}
          </span>
        </div>
      )}

      <div className="card">
        {inboxes.length > 0 ? (
          <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Label</th>
                <th>Address</th>
                <th>Provider</th>
                <th>Status</th>
                <th>Calls (30d)</th>
                <th className="right">{""}</th>
              </tr>
            </thead>
            <tbody>
              {inboxes.map(ib => (
                <tr key={ib.id}>
                  <td><strong style={{ fontWeight: 600 }}>{ib.label}</strong></td>
                  <td className="mono">{ib.address}</td>
                  <td>
                    <span style={{ display:"inline-flex", alignItems:"center", gap:8 }}>
                      <ProviderLogo kind={ib.provider} size={18} />
                      <span style={{ textTransform:"capitalize", color:"var(--fg-2)" }}>{ib.provider}</span>
                    </span>
                  </td>
                  <td>
                    {ib.status === "active"  ? <Badge tone="live"    dot="live">Connected</Badge>  : null}
                    {ib.status === "pending" ? <Badge tone="neutral">Pending</Badge>               : null}
                    {ib.status === "error"   ? (
                      <div>
                        <Badge tone="red" dot="red">Error</Badge>
                        {ib.lastError ? (
                          <div style={{
                            marginTop: 4,
                            fontSize: 11,
                            color: "var(--red-700)",
                            maxWidth: 220,
                            lineHeight: 1.4,
                            fontFamily: "var(--font-sans)",
                          }}>
                            {ib.lastError}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {ib.status === "revoked" ? <Badge tone="amber"   dot="amber">Expired</Badge>   : null}
                  </td>
                  <td className="mono">{ib.calls.toLocaleString()}</td>
                  <td className="right">
                    {ib.status === "error" ? (
                      <Btn
                        variant="secondary"
                        size="sm"
                        icon="refresh"
                        onClick={() => onReconnect(ib)}
                      >
                        Reconnect
                      </Btn>
                    ) : (
                      <Btn variant="ghost" size="sm" icon="refresh">{""}</Btn>
                    )}
                    <Btn
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      onClick={() => handleDisconnectRequest(ib)}
                    >
                      {""}
                    </Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="empty">
            <div className="ico"><Icon name="inbox" size={20} /></div>
            <h3>No inboxes connected</h3>
            <p>Connect Gmail, Outlook, or any IMAP provider to give your agents access.</p>
            <div style={{ marginTop: 8 }}>
              <Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>
            </div>
          </div>
        )}
      </div>

      {/* Disconnect confirmation dialog */}
      {confirmInbox && (
        <DisconnectDialog
          inbox={confirmInbox}
          disconnecting={disconnecting}
          onConfirm={handleDisconnectConfirm}
          onCancel={handleDisconnectCancel}
        />
      )}
    </div>
  );
}

function DisconnectDialog({ inbox, disconnecting, onConfirm, onCancel }) {
  return (
    <div className="scrim" onClick={onCancel}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 420 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="disconnect-dialog-title"
      >
        {/* Header */}
        <div className="modal-h">
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h2 id="disconnect-dialog-title" style={{ margin: 0 }}>
                Disconnect inbox?
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                This will revoke OAuth access and remove this inbox from your workspace.
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={disconnecting}
              aria-label="Cancel"
              style={{
                background: "transparent",
                border: "none",
                cursor: disconnecting ? "not-allowed" : "pointer",
                color: "var(--fg-3)",
                padding: 4,
                flexShrink: 0,
                lineHeight: 1,
                opacity: disconnecting ? 0.4 : 1,
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body">
          {/* Inbox identity summary */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 14px",
            background: "var(--bg-sunken)",
            borderRadius: 10,
            marginBottom: 20,
          }}>
            <ProviderLogo kind={inbox.provider} size={22} />
            <div>
              <div style={{ fontFamily: "var(--font-sans)", fontSize: 13.5, fontWeight: 600, color: "var(--fg-1)" }}>
                {inbox.label}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)", marginTop: 1 }}>
                {inbox.address}
              </div>
            </div>
          </div>

          <p style={{
            margin: "0 0 20px",
            fontFamily: "var(--font-sans)",
            fontSize: 13.5,
            color: "var(--fg-2)",
            lineHeight: 1.55,
          }}>
            Any API keys currently authorised to access this inbox will lose access immediately.
            You can reconnect this inbox at any time.
          </p>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onCancel} disabled={disconnecting}>
              Cancel
            </Btn>
            <Btn variant="danger" icon="trash" onClick={onConfirm} disabled={disconnecting}>
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── API Keys helpers ─────────────────────────────────────────────────────── */

/**
 * Formats a UTC ISO timestamp as a short absolute date, e.g. "24 May 2026".
 * Returns "—" for null/undefined values (e.g. last_used_at before first use).
 */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Formats last_used_at as a relative time when recent, falling back to
 * absolute date for older entries. Returns "Never" when null.
 */
function formatLastUsed(iso) {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(iso);
}

/**
 * Builds the masked key string shown in the dashboard.
 *
 * We store only the first 8 hex characters of the key suffix (key_prefix).
 * The full 64-character suffix is never stored after creation — the raw key
 * is shown once at creation time and then discarded.
 *
 * Display format:  mcpe_<key_prefix>••••••••••••••••••••••••••
 */
function maskedKey(keyPrefix) {
  return `mcpe_${keyPrefix}${'•'.repeat(24)}`;
}

/* ── CreateKeyModal ───────────────────────────────────────────────────────── */

const SCOPE_OPTIONS = [
  { value: 'email:read',   label: 'email:read',   desc: 'Read email messages and attachments' },
  { value: 'email:send',   label: 'email:send',   desc: 'Send and reply to emails' },
  { value: 'email:search', label: 'email:search', desc: 'Search across inbox contents' },
  { value: 'inbox:manage', label: 'inbox:manage', desc: 'Manage folders and organise messages' },
  { value: 'admin',        label: 'admin',        desc: 'Inspect workspace configuration' },
];

/**
 * Modal for creating a new API key.
 * Collects a name and one or more scopes, then calls onCreate(name, scopes).
 * While the request is in flight, inputs are disabled and the button shows a
 * spinner label. Errors surface inline below the form.
 */
function CreateKeyModal({ onCreate, onCancel }) {
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const toggleScope = (value) => {
    setSelectedScopes(prev =>
      prev.includes(value) ? prev.filter(s => s !== value) : [...prev, value]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Name is required.');
      return;
    }
    if (trimmed.length > 128) {
      setError('Name must be 128 characters or fewer.');
      return;
    }
    if (selectedScopes.length === 0) {
      setError('Select at least one scope.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await onCreate(trimmed, selectedScopes);
      // onCreate resolves with key data; parent (KeysPage) handles the reveal modal.
    } catch (err) {
      setError(err?.message ?? 'Failed to create API key. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="scrim" onClick={submitting ? undefined : onCancel}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 480 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-key-dialog-title"
      >
        {/* Header */}
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="create-key-dialog-title" style={{ margin: 0 }}>New API key</h2>
              <div className="sub" style={{ marginTop: 4 }}>
                Give your key a name and choose its permissions.
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={submitting}
              aria-label="Cancel"
              style={{
                background: 'transparent', border: 'none',
                cursor: submitting ? 'not-allowed' : 'pointer',
                color: 'var(--fg-3)', padding: 4, flexShrink: 0,
                lineHeight: 1, opacity: submitting ? 0.4 : 1,
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Name field */}
            <div className="field" style={{ marginBottom: 20 }}>
              <label htmlFor="key-name" style={{
                display: 'block', fontFamily: 'var(--font-sans)', fontSize: 13,
                fontWeight: 500, color: 'var(--fg-2)', marginBottom: 6,
              }}>
                Key name
              </label>
              <input
                id="key-name"
                className="input"
                type="text"
                placeholder="e.g. Claude Desktop, My Agent"
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={submitting}
                maxLength={128}
                autoFocus
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
            </div>

            {/* Scopes */}
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                color: 'var(--fg-2)', marginBottom: 8,
              }}>
                Permissions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {SCOPE_OPTIONS.map(opt => {
                  const checked = selectedScopes.includes(opt.value);
                  return (
                    <label
                      key={opt.value}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        padding: '10px 12px',
                        border: `1px solid ${checked ? 'var(--border-focus)' : 'var(--border-1)'}`,
                        borderRadius: 8,
                        background: checked ? 'var(--brand-soft)' : 'var(--bg-surface)',
                        cursor: submitting ? 'not-allowed' : 'pointer',
                        transition: 'border-color 120ms, background 120ms',
                        opacity: submitting ? 0.7 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => !submitting && toggleScope(opt.value)}
                        disabled={submitting}
                        style={{ marginTop: 1, accentColor: 'var(--brand)', flexShrink: 0 }}
                      />
                      <div>
                        <code style={{
                          fontFamily: 'var(--font-mono)', fontSize: 12.5,
                          color: checked ? 'var(--cobalt-700)' : 'var(--fg-1)',
                          fontWeight: 500,
                        }}>
                          {opt.label}
                        </code>
                        <div style={{
                          fontFamily: 'var(--font-sans)', fontSize: 12,
                          color: 'var(--fg-3)', marginTop: 1,
                        }}>
                          {opt.desc}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div style={{
                marginBottom: 16, padding: '10px 12px',
                background: 'var(--red-100)', border: '1px solid rgba(229,72,77,0.25)',
                borderRadius: 8, fontFamily: 'var(--font-sans)', fontSize: 13,
                color: 'var(--red-700)',
              }}>
                {error}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="secondary" onClick={onCancel} disabled={submitting}>
                Cancel
              </Btn>
              <Btn variant="primary" icon="key" type="submit" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create key'}
              </Btn>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── KeyRevealModal ───────────────────────────────────────────────────────── */

/**
 * One-time key reveal modal.
 *
 * Shows the full raw key exactly once. The modal cannot be dismissed via the
 * backdrop or the × button until the user explicitly checks the acknowledge
 * checkbox. This enforces the one-time-reveal contract: if the user closes
 * without copying, the key cannot be retrieved.
 *
 * Props:
 *   rawKey   — the full plaintext key string (mcpe_<64 hex chars>)
 *   keyName  — human-readable name for context
 *   onDone   — called when the user clicks "Done" after acknowledging
 */
function KeyRevealModal({ rawKey, keyName, onDone }) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [visible, setVisible] = useState(false);

  const handleCopy = () => {
    navigator.clipboard?.writeText(rawKey).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="scrim">
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 520 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reveal-key-dialog-title"
      >
        {/* Header */}
        <div className="modal-h">
          <div>
            <h2 id="reveal-key-dialog-title" style={{ margin: 0 }}>
              Copy your API key
            </h2>
            <div className="sub" style={{ marginTop: 4 }}>
              This is the only time your key will be shown. Copy it now.
            </div>
          </div>
        </div>

        <div className="modal-body">
          {/* Key name context */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 12px', marginBottom: 16,
            background: 'var(--brand-soft)',
            border: '1px solid rgba(37,71,229,0.15)', borderRadius: 8,
          }}>
            <Icon name="key" size={16} color="var(--brand)" />
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)' }}>
              {keyName}
            </span>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginLeft: 2 }}>
              · created just now
            </span>
          </div>

          {/* Key value */}
          <div style={{
            position: 'relative', marginBottom: 16,
            background: 'var(--bg-inverse)', borderRadius: 10,
            padding: '14px 50px 14px 16px',
          }}>
            <code style={{
              fontFamily: 'var(--font-mono)', fontSize: 13,
              color: '#E6EAFB', lineHeight: 1.5, wordBreak: 'break-all',
              filter: visible ? 'none' : 'blur(5px)',
              userSelect: visible ? 'text' : 'none',
              transition: 'filter 200ms',
              display: 'block',
            }}>
              {rawKey}
            </code>
            {/* Show/hide toggle */}
            <button
              onClick={() => setVisible(v => !v)}
              title={visible ? 'Hide key' : 'Show key'}
              style={{
                position: 'absolute', right: 44, top: '50%', transform: 'translateY(-50%)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'rgba(230,234,251,0.55)', padding: '4px',
                display: 'flex', alignItems: 'center',
              }}
            >
              <Icon name={visible ? 'eyeoff' : 'eye'} size={15} color="rgba(230,234,251,0.55)" />
            </button>
            {/* Copy button */}
            <button
              onClick={handleCopy}
              title="Copy key"
              style={{
                position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: copied ? 'var(--mint-500)' : 'rgba(230,234,251,0.55)', padding: '4px',
                display: 'flex', alignItems: 'center',
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} size={15} color={copied ? 'var(--mint-500)' : 'rgba(230,234,251,0.55)'} />
            </button>
          </div>

          {/* Warning */}
          <div style={{
            display: 'flex', gap: 8, alignItems: 'flex-start',
            padding: '10px 12px', marginBottom: 20,
            background: 'var(--amber-100)', border: '1px solid rgba(240,165,62,0.25)',
            borderRadius: 8,
          }}>
            <Icon name="zap" size={14} color="var(--amber-700)" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--amber-700)', lineHeight: 1.5 }}>
              Store this key somewhere safe — it cannot be shown again. If you lose it, revoke this key and create a new one.
            </span>
          </div>

          {/* Acknowledge checkbox */}
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            marginBottom: 20, cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={e => setAcknowledged(e.target.checked)}
              style={{ marginTop: 2, accentColor: 'var(--brand)', flexShrink: 0 }}
            />
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5 }}>
              I have copied my API key and understand it cannot be shown again.
            </span>
          </label>

          {/* Done button — only enabled after acknowledge */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="primary" onClick={onDone} disabled={!acknowledged}>
              Done
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── RevokeDialog ─────────────────────────────────────────────────────────── */

function RevokeDialog({ apiKey, revoking, onConfirm, onCancel }) {
  return (
    <div className="scrim" onClick={onCancel}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 420 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="revoke-dialog-title"
      >
        <div className="modal-h">
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h2 id="revoke-dialog-title" style={{ margin: 0 }}>Revoke API key?</h2>
              <div className="sub" style={{ marginTop: 4 }}>
                This key will stop working immediately. This cannot be undone.
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={revoking}
              aria-label="Cancel"
              style={{
                background: "transparent", border: "none",
                cursor: revoking ? "not-allowed" : "pointer",
                color: "var(--fg-3)", padding: 4, flexShrink: 0,
                lineHeight: 1, opacity: revoking ? 0.4 : 1,
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {/* Key identity summary */}
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 14px", background: "var(--bg-sunken)",
            borderRadius: 10, marginBottom: 20,
          }}>
            <Icon name="key" size={20} color="var(--fg-3)" />
            <div>
              <div style={{ fontFamily: "var(--font-sans)", fontSize: 13.5, fontWeight: 600, color: "var(--fg-1)" }}>
                {apiKey.name}
              </div>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>
                {maskedKey(apiKey.keyPrefix)}
              </code>
            </div>
          </div>

          <p style={{ margin: "0 0 20px", fontFamily: "var(--font-sans)", fontSize: 13.5, color: "var(--fg-2)", lineHeight: 1.55 }}>
            Any MCP client using this key will be disconnected. You can create a new key at any time.
          </p>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onCancel} disabled={revoking}>Cancel</Btn>
            <Btn variant="danger" icon="trash" onClick={onConfirm} disabled={revoking}>
              {revoking ? "Revoking…" : "Revoke key"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- API Keys ---------------- */
export function KeysPage({ keys, onCreate, onKeyCreated, onRevoke }) {
  const [copiedId, setCopiedId] = useState(null);
  // The key object pending revoke confirmation, or null.
  const [confirmKey, setConfirmKey] = useState(null);
  // True while the revoke API call is in flight.
  const [revoking, setRevoking] = useState(false);
  // True when the create-key modal is open.
  const [createOpen, setCreateOpen] = useState(false);
  // The newly-created key data (including rawKey) to display in the reveal modal.
  const [revealData, setRevealData] = useState(null);

  const copyPrefix = (k) => {
    navigator.clipboard?.writeText(`mcpe_${k.keyPrefix}`);
    setCopiedId(k.id);
    setTimeout(() => setCopiedId(null), 1400);
  };

  const handleRevokeRequest = (k) => setConfirmKey(k);
  const handleRevokeCancel  = () => { if (!revoking) setConfirmKey(null); };

  const handleRevokeConfirm = async () => {
    if (!confirmKey || revoking) return;
    setRevoking(true);
    try {
      await onRevoke(confirmKey.id);
      setConfirmKey(null);
    } catch {
      // onRevoke already showed an error toast; leave dialog open.
    } finally {
      setRevoking(false);
    }
  };

  /**
   * Called by CreateKeyModal on submit. Delegates to the App-level `onCreate`
   * handler which makes the API call. On success, closes the create modal and
   * opens the reveal modal with the one-time raw key.
   */
  const handleCreate = async (name, scopes) => {
    const data = await onCreate(name, scopes);
    // data includes: id, name, keyPrefix, scopes, createdAt, lastUsedAt, expiresAt, rawKey
    setCreateOpen(false);
    setRevealData(data);
  };

  /**
   * Called when the user clicks "Done" in the reveal modal (after acknowledging).
   * Adds the new key row to the parent's state and closes the reveal modal.
   */
  const handleRevealDone = () => {
    if (!revealData) return;
    const { rawKey: _, ...keyRow } = revealData; // strip rawKey before adding to state
    onKeyCreated(keyRow);
    setRevealData(null);
  };

  return (
    <div className="page">
      <PageHeader
        title="API keys"
        sub="Used by MCP clients to authenticate against mcpemails.com."
        action={<Btn variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>New key</Btn>}
      />

      <div className="card">
        {keys.length > 0 ? (
          <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th className="right">{""}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id}>
                  <td><strong style={{ fontWeight: 600 }}>{k.name}</strong></td>
                  <td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <code className="mono" style={{ background: "var(--bg-sunken)", padding: "3px 8px", borderRadius: 6, letterSpacing: "0.01em" }}>
                        {maskedKey(k.keyPrefix)}
                      </code>
                      <Btn
                        variant="ghost"
                        size="sm"
                        icon={copiedId === k.id ? "check" : "copy"}
                        onClick={() => copyPrefix(k)}
                        title="Copy key prefix"
                      >{""}</Btn>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {k.scopes.length === 0
                        ? <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--fg-3)" }}>No scopes</span>
                        : k.scopes.map(s => <Badge key={s} tone="neutral">{s}</Badge>)
                      }
                    </div>
                  </td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--fg-2)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
                    {formatDate(k.createdAt)}
                  </td>
                  <td style={{ whiteSpace: "nowrap", color: k.lastUsedAt ? "var(--fg-2)" : "var(--fg-3)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
                    {formatLastUsed(k.lastUsedAt)}
                  </td>
                  <td className="right">
                    <Btn variant="danger" size="sm" onClick={() => handleRevokeRequest(k)}>Revoke</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="empty">
            <div className="ico"><Icon name="key" size={20} /></div>
            <h3>No API keys yet</h3>
            <p>Create a key to connect Claude Desktop or any MCP client to your inboxes.</p>
            <div style={{ marginTop: 8 }}>
              <Btn variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>New key</Btn>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <div>
            <div className="title">Connect from Claude Code or Claude Desktop</div>
            <div className="sub">Add to <code className="t-code-inline">~/.claude/mcp.json</code> (Claude Code) or <code className="t-code-inline">claude_desktop_config.json</code> (Claude Desktop)</div>
          </div>
        </div>
        <div className="card-body">
          <pre style={{ margin: 0, background: "var(--bg-inverse)", color: "#E6EAFB", borderRadius: 10, padding: "16px 18px", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.7, overflow: "auto" }}>
{`{
  "mcpServers": {
    "mcpemails": {
      "url": "https://mcpemails.com/api/mcp",
      "auth": { "type": "bearer", "token": "mcpe_••••••••" }
    }
  }
}`}
          </pre>
        </div>
      </div>

      {confirmKey && (
        <RevokeDialog
          apiKey={confirmKey}
          revoking={revoking}
          onConfirm={handleRevokeConfirm}
          onCancel={handleRevokeCancel}
        />
      )}

      {createOpen && (
        <CreateKeyModal
          onCreate={handleCreate}
          onCancel={() => setCreateOpen(false)}
        />
      )}

      {revealData && (
        <KeyRevealModal
          rawKey={revealData.rawKey}
          keyName={revealData.name}
          onDone={handleRevealDone}
        />
      )}
    </div>
  );
}

/* ---------------- Usage ---------------- */

/**
 * UsagePage — real data from activity_log, passed as the `usageData` prop.
 *
 * usageData shape:
 *   dailyCounts  — Array<{ date: "YYYY-MM-DD", count: number }>, 30 entries oldest-first
 *   totalCalls   — number  (sum over the 30-day window)
 *   byTool       — Array<{ tool: string, count: number, pct: number }>, sorted desc
 *   byInbox      — Array<{ inboxId: string, label: string, address: string, count: number, pct: number }>, sorted desc
 */
export function UsagePage({ usageData, planLimits, onConnect, onGoToKeys }) {
  const {
    dailyCounts = [],
    totalCalls = 0,
    byTool = [],
    byInbox = [],
  } = usageData ?? {};

  // Plan limits — null means unlimited (Enterprise).
  const dailyCap = planLimits?.maxDailyBurstCalls ?? null;

  // Calls today: the last entry in dailyCounts (index 29) is today.
  const callsToday = dailyCounts.length > 0 ? (dailyCounts[dailyCounts.length - 1]?.count ?? 0) : 0;
  const dailyPct = dailyCap != null && dailyCap > 0 ? callsToday / dailyCap : 0;
  const dailyAtLimit = dailyCap != null && callsToday >= dailyCap;
  const dailyNearLimit = !dailyAtLimit && dailyCap != null && dailyPct >= 0.8;

  // Derived stats
  const avgPerDay = totalCalls > 0 ? Math.round(totalCalls / 30) : 0;
  const busiestDay = dailyCounts.reduce(
    (best, d) => (d.count > best.count ? d : best),
    { date: '', count: 0 },
  );

  // Show a page-level empty state when there is no usage data yet.
  const isEmpty = totalCalls === 0;

  return (
    <div className="page">
      <PageHeader
        title="Usage"
        sub="MCP tool calls over the last 30 days across all inboxes."
      />

      {/* Daily quota status card — shown whenever a cap exists */}
      {dailyCap != null && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '14px 18px',
          marginBottom: 14,
          background: dailyAtLimit
            ? 'var(--red-100, #fef2f2)'
            : dailyNearLimit
              ? 'var(--amber-50, #fffbeb)'
              : 'var(--bg-card, #fff)',
          border: dailyAtLimit
            ? '1px solid rgba(229,72,77,0.25)'
            : dailyNearLimit
              ? '1px solid rgba(245,158,11,0.3)'
              : '1px solid var(--border)',
          borderRadius: 10,
          fontFamily: 'var(--font-sans)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{
              fontSize: 13,
              fontWeight: 600,
              color: dailyAtLimit
                ? 'var(--red-700, #b91c1c)'
                : dailyNearLimit
                  ? 'var(--amber-800, #92400e)'
                  : 'var(--fg-1)',
              marginBottom: 6,
            }}>
              {dailyAtLimit
                ? 'Daily quota exhausted — MCP calls are being rejected'
                : dailyNearLimit
                  ? `Daily quota at ${Math.round(dailyPct * 100)}% — approaching limit`
                  : 'Daily quota'}
            </div>
            <div style={{
              height: 6,
              borderRadius: 3,
              background: 'var(--bg-sunken, #f1f5f9)',
              overflow: 'hidden',
              marginBottom: 6,
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, dailyPct * 100)}%`,
                background: dailyAtLimit
                  ? 'var(--red-500, #ef4444)'
                  : dailyNearLimit
                    ? 'var(--amber-500, #f59e0b)'
                    : 'var(--brand)',
                borderRadius: 3,
                transition: 'width 0.4s',
              }} />
            </div>
            <div style={{
              fontSize: 12,
              color: dailyAtLimit
                ? 'var(--red-600, #dc2626)'
                : 'var(--fg-3)',
            }}>
              {callsToday.toLocaleString()} of {dailyCap.toLocaleString()} calls used today (UTC day)
              {dailyAtLimit && ' · resets at midnight UTC'}
            </div>
          </div>
          {(dailyAtLimit || dailyNearLimit) && (
            <a
              href="/pricing"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 14px',
                height: 34,
                background: 'var(--brand)',
                color: '#fff',
                borderRadius: 8,
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 500,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              <Icon name="zap" size={13} color="#fff" />
              Upgrade plan
            </a>
          )}
        </div>
      )}

      {isEmpty ? (
        /* ── Empty state ───────────────────────────────────────────────── */
        <div className="card" style={{ marginTop: 14 }}>
          <div className="empty">
            <div className="ico">
              <Icon name="activity" size={20} />
            </div>
            <h3>No MCP calls yet</h3>
            <p>
              Usage data will appear here once your AI agent starts making tool
              calls. Connect an inbox and create an API key to get started.
            </p>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {onConnect && (
                <Btn variant="primary" icon="plus" onClick={onConnect}>
                  Connect inbox
                </Btn>
              )}
              {onGoToKeys && (
                <Btn variant="secondary" icon="key" onClick={onGoToKeys}>
                  Create API key
                </Btn>
              )}
              <a
                href="/docs"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  color: 'var(--brand)',
                  textDecoration: 'none',
                  fontWeight: 500,
                  padding: '0 2px',
                }}
              >
                View quick-start docs →
              </a>
            </div>
          </div>
        </div>
      ) : (
        /* ── Normal state ──────────────────────────────────────────────── */
        <>
          {/* Summary stats */}
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className="stat">
              <div className="label">Total calls (30d)</div>
              <div className="value">{totalCalls.toLocaleString()}</div>
              <div className="delta">across all tools and inboxes</div>
            </div>
            <div className="stat">
              <div className="label">Daily average</div>
              <div className="value">{avgPerDay.toLocaleString()}</div>
              <div className="delta">calls per day</div>
            </div>
            <div className="stat">
              <div className="label">Busiest day</div>
              <div className="value">{busiestDay.count.toLocaleString()}</div>
              <div className="delta">
                {busiestDay.date ? formatBarDate(busiestDay.date) : '—'}
              </div>
            </div>
          </div>

          {/* 30-day bar chart */}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-h">
              <div>
                <div className="title">Calls per day</div>
                <div className="sub">Last 30 days · all tools and inboxes</div>
              </div>
            </div>
            <div className="card-body">
              <UsageChart30 dailyCounts={dailyCounts} />
            </div>
          </div>

          {/* Breakdown by tool */}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-h">
              <div className="title">Calls by tool</div>
            </div>
            {byTool.length === 0 ? (
              <div className="empty" style={{ padding: '28px 20px' }}>
                <div className="ico"><Icon name="zap" size={18} /></div>
                <h3 style={{ fontSize: 14 }}>No tool calls recorded</h3>
                <p style={{ fontSize: 12.5 }}>No calls in the last 30 days.</p>
              </div>
            ) : (
              <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Calls</th>
                    <th>Share</th>
                    <th style={{ width: 200 }}>{''}</th>
                  </tr>
                </thead>
                <tbody>
                  {byTool.map((t) => (
                    <tr key={t.tool}>
                      <td>
                        <code
                          className="mono"
                          style={{ color: 'var(--cobalt-700)', fontWeight: 500 }}
                        >
                          {t.tool}
                        </code>
                      </td>
                      <td className="mono">{t.count.toLocaleString()}</td>
                      <td className="mono">{t.pct}%</td>
                      <td>
                        <div style={{
                          height: 6,
                          borderRadius: 3,
                          background: 'var(--ink-100)',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            width: t.pct + '%',
                            height: '100%',
                            background: 'var(--cobalt-500)',
                            borderRadius: 3,
                            transition: 'width 400ms var(--ease-out)',
                          }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>

          {/* Breakdown by inbox — only shown when multiple inboxes have activity */}
          {byInbox.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-h">
                <div className="title">Calls by inbox</div>
              </div>
              <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Inbox</th>
                    <th>Address</th>
                    <th>Calls</th>
                    <th>Share</th>
                    <th style={{ width: 200 }}>{''}</th>
                  </tr>
                </thead>
                <tbody>
                  {byInbox.map((ib) => (
                    <tr key={ib.inboxId}>
                      <td>
                        <strong style={{ fontWeight: 600 }}>{ib.label}</strong>
                      </td>
                      <td className="mono" style={{ color: 'var(--fg-3)' }}>
                        {ib.address}
                      </td>
                      <td className="mono">{ib.count.toLocaleString()}</td>
                      <td className="mono">{ib.pct}%</td>
                      <td>
                        <div style={{
                          height: 6,
                          borderRadius: 3,
                          background: 'var(--ink-100)',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            width: ib.pct + '%',
                            height: '100%',
                            background: 'var(--cobalt-400)',
                            borderRadius: 3,
                            transition: 'width 400ms var(--ease-out)',
                          }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- Settings ---------------- */

/**
 * ProfileSection — display name update form + read-only email display.
 *
 * Calls PATCH /api/user/profile on submit and surfaces success / error
 * feedback inline below the form using the same inline feedback pattern
 * used elsewhere in the dashboard.
 *
 * Props:
 *   displayName — current display name from the users table (may be empty string)
 *   email       — read-only email address from Supabase Auth (never editable here)
 */
function ProfileSection({ displayName: initialDisplayName, email }) {
  const [name, setName] = useState(initialDisplayName ?? '');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // True when there is a pending unsaved change
  const isDirty = name.trim() !== (initialDisplayName ?? '').trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast({ message: 'Display name cannot be empty.', variant: 'error' });
      return;
    }
    if (trimmed.length > 100) {
      toast({ message: 'Display name must be 100 characters or fewer.', variant: 'error' });
      return;
    }

    setSaving(true);

    try {
      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: trimmed }),
      });

      if (!res.ok) {
        let message = 'Failed to save changes.';
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore */ }
        toast({ message, variant: 'error' });
        return;
      }

      toast({ message: 'Profile updated.', variant: 'success' });
    } catch {
      toast({ message: 'Network error — please try again.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setName(initialDisplayName ?? '');
    setFeedback({ state: 'idle', message: '' });
  };

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="card-h">
        <div>
          <div className="title">Profile</div>
          <div className="sub">Your name as it appears in the dashboard and audit logs.</div>
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Display name — editable */}
          <div className="field">
            <label
              htmlFor="profile-display-name"
              style={{
                display: 'block',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--fg-2)',
                marginBottom: 6,
              }}
            >
              Display name
            </label>
            <input
              id="profile-display-name"
              className="input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={saving}
              maxLength={100}
              placeholder="Your name"
              style={{ width: '100%', boxSizing: 'border-box' }}
              autoComplete="name"
            />
          </div>

          {/* Email — read-only */}
          <div className="field">
            <label
              htmlFor="profile-email"
              style={{
                display: 'block',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--fg-2)',
                marginBottom: 6,
              }}
            >
              Email address
            </label>
            <input
              id="profile-email"
              className="input"
              type="email"
              value={email ?? ''}
              readOnly
              disabled
              style={{
                width: '100%',
                boxSizing: 'border-box',
                cursor: 'default',
                opacity: 0.7,
              }}
              aria-describedby="profile-email-hint"
            />
            <span
              id="profile-email-hint"
              style={{
                display: 'block',
                marginTop: 4,
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                color: 'var(--fg-3)',
              }}
            >
              Email cannot be changed here. Contact support to update your email address.
            </span>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn
              variant="secondary"
              type="button"
              onClick={handleCancel}
              disabled={saving || !isDirty}
            >
              Cancel
            </Btn>
            <Btn
              variant="primary"
              type="submit"
              disabled={saving || !isDirty}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Btn>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * PasswordSection — change-password form.
 *
 * Collects the current password (for re-authentication / verification) plus
 * a new password and a confirmation field. Validation is done client-side
 * first; the API route performs server-side validation and verifies the
 * current password via supabase.auth.signInWithPassword before calling
 * supabase.auth.updateUser({ password: newPassword }).
 *
 * Success and error feedback are surfaced via the parent's toast handler
 * (onToast) rather than inline, matching the pattern used by other
 * dashboard actions (inbox disconnect, key revoke, etc.).
 */
function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  // Inline error for client-side validation failures only.
  // Server-side errors are surfaced via the toast.
  const [inlineError, setInlineError] = useState(null);
  const { toast } = useToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    setInlineError(null);

    // Client-side validation — surface immediately inline so the user can
    // fix typos without waiting for a round trip.
    if (!currentPassword) {
      setInlineError('Current password is required.');
      return;
    }
    if (!newPassword) {
      setInlineError('New password is required.');
      return;
    }
    if (newPassword.length < 8) {
      setInlineError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setInlineError('New passwords do not match.');
      return;
    }
    if (currentPassword === newPassword) {
      setInlineError('New password must be different from your current password.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/user/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!res.ok) {
        let message = 'Failed to update password.';
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore JSON parse failure */ }
        toast({ message, variant: 'error' });
        return;
      }

      // Clear all fields on success so the form is ready for future use.
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast({ message: 'Password updated successfully.', variant: 'success' });
    } catch {
      toast({ message: 'Network error — please try again.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const labelStyle = {
    display: 'block',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--fg-2)',
    marginBottom: 6,
  };

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
      <div className="card-h">
        <div>
          <div className="title">Change password</div>
          <div className="sub">Choose a strong password at least 8 characters long.</div>
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Current password */}
          <div className="field">
            <label htmlFor="pwd-current" style={labelStyle}>
              Current password
            </label>
            <input
              id="pwd-current"
              className="input"
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              disabled={saving}
              autoComplete="current-password"
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {/* New password */}
          <div className="field">
            <label htmlFor="pwd-new" style={labelStyle}>
              New password
            </label>
            <input
              id="pwd-new"
              className="input"
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              disabled={saving}
              autoComplete="new-password"
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {/* Confirm new password */}
          <div className="field">
            <label htmlFor="pwd-confirm" style={labelStyle}>
              Confirm new password
            </label>
            <input
              id="pwd-confirm"
              className="input"
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              disabled={saving}
              autoComplete="new-password"
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {/* Inline validation error */}
          {inlineError && (
            <div
              role="alert"
              style={{
                padding: '10px 12px',
                borderRadius: 8,
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                background: 'var(--red-100)',
                border: '1px solid rgba(229,72,77,0.25)',
                color: 'var(--red-700)',
              }}
            >
              {inlineError}
            </div>
          )}

          {/* Action */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="primary" type="submit" disabled={saving}>
              {saving ? 'Updating…' : 'Update password'}
            </Btn>
          </div>
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DeleteAccountSection                                                 */
/*                                                                     */
/* Renders the danger zone card. Clicking "Delete account" opens an   */
/* inline confirmation dialog that requires the user to type their     */
/* email before the final delete button becomes active.               */
/*                                                                     */
/* Flow:                                                               */
/*   1. User clicks "Delete account" → dialog opens                   */
/*   2. User types their email in the confirmation input              */
/*   3. Only when the input matches, the confirm button activates      */
/*   4. On confirm: POST /api/user/delete-account, then redirect to / */
/* ------------------------------------------------------------------ */
function DeleteAccountSection({ email }) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  const emailMatches =
    confirmValue.trim().toLowerCase() === (email ?? '').toLowerCase();

  function handleOpen() {
    setConfirmValue('');
    setError(null);
    setOpen(true);
  }

  function handleCancel() {
    if (deleting) return;
    setOpen(false);
    setConfirmValue('');
    setError(null);
  }

  async function handleConfirm() {
    if (!emailMatches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch('/api/user/delete-account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail: confirmValue.trim() }),
      });
      if (!res.ok) {
        let msg = 'Failed to delete account. Please try again.';
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') msg = data.error;
        } catch { /* ignore */ }
        setError(msg);
        setDeleting(false);
        return;
      }
      // Server signed us out. Redirect to homepage.
      window.location.href = '/';
    } catch {
      setError('Network error. Please check your connection and try again.');
      setDeleting(false);
    }
  }

  return (
    <>
      {/* Danger zone card */}
      <div
        className="card"
        style={{
          maxWidth: 640,
          marginTop: 14,
          borderColor: 'rgba(229,72,77,0.25)',
        }}
      >
        <div
          className="card-h"
          style={{ borderColor: 'rgba(229,72,77,0.25)' }}
        >
          <div>
            <div className="title" style={{ color: 'var(--red-700)' }}>
              Delete account
            </div>
            <div className="sub">
              All connected inboxes and API keys will be revoked immediately.
              This cannot be undone.
            </div>
          </div>
        </div>
        <div
          className="card-body"
          style={{ display: 'flex', justifyContent: 'flex-end' }}
        >
          <Btn variant="danger" onClick={handleOpen}>
            Delete account
          </Btn>
        </div>
      </div>

      {/* Confirmation dialog — rendered as a modal overlay */}
      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCancel();
          }}
        >
          <div
            className="card"
            style={{
              width: 420,
              maxWidth: 'calc(100vw - 32px)',
              background: 'var(--surface)',
              borderColor: 'rgba(229,72,77,0.35)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              borderRadius: 12,
            }}
          >
            {/* Header */}
            <div
              className="card-h"
              style={{
                borderColor: 'rgba(229,72,77,0.35)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <Icon
                name="alert-triangle"
                size={18}
                color="var(--red-600)"
                style={{ marginTop: 2, flexShrink: 0 }}
              />
              <div>
                <div
                  className="title"
                  style={{ color: 'var(--red-700)', fontSize: 15 }}
                >
                  Delete your account?
                </div>
                <div className="sub" style={{ marginTop: 4 }}>
                  This will immediately revoke all API keys and disconnect all
                  inboxes. Your data is retained for audit purposes but you will
                  lose access permanently.
                </div>
              </div>
            </div>

            {/* Body */}
            <div
              className="card-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <div>
                <label
                  htmlFor="delete-account-confirm"
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--fg-2)',
                    marginBottom: 8,
                  }}
                >
                  Type{' '}
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--fg-1)',
                      background: 'var(--surface-2)',
                      padding: '1px 5px',
                      borderRadius: 4,
                    }}
                  >
                    {email}
                  </span>{' '}
                  to confirm:
                </label>
                <input
                  id="delete-account-confirm"
                  className="input"
                  type="email"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmValue}
                  onChange={(e) => {
                    setConfirmValue(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && emailMatches) handleConfirm();
                    if (e.key === 'Escape') handleCancel();
                  }}
                  placeholder={email}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  disabled={deleting}
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
              </div>

              {error && (
                <div
                  style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    color: 'var(--red-600)',
                    padding: '8px 12px',
                    background: 'rgba(229,72,77,0.07)',
                    borderRadius: 6,
                    border: '1px solid rgba(229,72,77,0.2)',
                  }}
                >
                  {error}
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                }}
              >
                <Btn
                  variant="secondary"
                  onClick={handleCancel}
                  disabled={deleting}
                >
                  Cancel
                </Btn>
                <Btn
                  variant="danger"
                  onClick={handleConfirm}
                  disabled={!emailMatches || deleting}
                >
                  {deleting ? 'Deleting…' : 'Delete account'}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ── BillingSection ───────────────────────────────────────────────────────── */

/**
 * Static plan data used for display purposes only.
 * Stripe price IDs are resolved server-side by POST /api/stripe/checkout.
 */
const BILLING_PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    monthlyPrice: 9,
    yearlyMonthlyPrice: 7,      // effective monthly cost when billed yearly ($84/yr)
    yearlyAnnualTotal: 84,
    features: ['3 connected inboxes', '3,000 MCP calls / month', '3 API keys', 'Email support', '14-day free trial'],
    highlighted: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    monthlyPrice: 29,
    yearlyMonthlyPrice: 23,     // effective monthly cost when billed yearly ($276/yr)
    yearlyAnnualTotal: 276,
    features: ['10 connected inboxes', '20,000 MCP calls / month', '10 API keys', 'Usage analytics', 'Email support', '14-day free trial'],
    highlighted: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyPrice: null,          // custom pricing
    yearlyMonthlyPrice: null,
    yearlyAnnualTotal: null,
    features: ['Unlimited inboxes', 'Unlimited MCP calls', 'Unlimited API keys', 'Audit log + SSO', 'Dedicated Slack support', 'Custom SLA'],
    highlighted: false,
  },
];

/**
 * BillingSection — shows the current plan and upgrade options.
 *
 * For free-plan workspaces it renders Pro and Enterprise upgrade cards.
 * For paid-plan workspaces it shows the active plan and a link to the
 * customer portal (task: Implement Stripe Customer Portal link).
 *
 * Props:
 *   currentPlan — 'free' | 'pro' | 'enterprise' from workspaces.plan
 */
function BillingSection({ currentPlan }) {
  const [interval, setInterval] = useState('month');
  const [upgrading, setUpgrading] = useState(null); // planId while loading
  const [openingPortal, setOpeningPortal] = useState(false);
  const [usage, setUsage] = useState(null); // fetched from /api/usage
  const { toast } = useToast();

  // Fetch live usage stats on mount
  useEffect(() => {
    fetch('/api/usage')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setUsage(data); })
      .catch(() => {});
  }, []);

  /** Open the Stripe Customer Portal in the same tab. */
  const handleOpenPortal = async () => {
    if (openingPortal) return;
    setOpeningPortal(true);
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        const message =
          typeof data?.error === 'string'
            ? data.error
            : 'Failed to open billing portal. Please try again.';
        toast({ message, variant: 'error' });
        return;
      }

      if (typeof data?.url === 'string') {
        window.location.href = data.url;
      } else {
        toast({ message: 'Unexpected response. Please try again.', variant: 'error' });
      }
    } catch {
      toast({ message: 'Network error — please try again.', variant: 'error' });
    } finally {
      setOpeningPortal(false);
    }
  };

  const handleUpgrade = async (planId) => {
    if (upgrading) return;
    setUpgrading(planId);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, interval }),
      });

      const data = await res.json();

      if (!res.ok) {
        const message =
          typeof data?.error === 'string'
            ? data.error
            : 'Failed to start checkout. Please try again.';
        toast({ message, variant: 'error' });
        return;
      }

      if (typeof data?.url === 'string') {
        // Redirect to Stripe Checkout hosted page
        window.location.href = data.url;
      } else {
        toast({ message: 'Unexpected response from checkout. Please try again.', variant: 'error' });
      }
    } catch {
      toast({ message: 'Network error — please try again.', variant: 'error' });
    } finally {
      setUpgrading(null);
    }
  };

  const isOnPaidPlan = currentPlan === 'solo' || currentPlan === 'pro' || currentPlan === 'enterprise';

  // Derived usage values for the widget
  const monthlyUsed = usage?.monthly?.used ?? null;
  const monthlyCap  = usage?.monthly?.cap  ?? null;
  const monthlyPct  = monthlyCap != null && monthlyCap > 0 ? (monthlyUsed ?? 0) / monthlyCap : 0;
  const monthlyAtLimit   = monthlyCap != null && (monthlyUsed ?? 0) >= monthlyCap;
  const monthlyNearLimit = !monthlyAtLimit && monthlyCap != null && monthlyPct >= 0.8;

  const dailyUsed = usage?.daily_burst?.used ?? null;
  const dailyCap  = usage?.daily_burst?.cap  ?? null;
  const dailyPct  = dailyCap != null && dailyCap > 0 ? (dailyUsed ?? 0) / dailyCap : 0;
  const dailyAtLimit   = dailyCap != null && (dailyUsed ?? 0) >= dailyCap;
  const dailyNearLimit = !dailyAtLimit && dailyCap != null && dailyPct >= 0.8;

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
      <div className="card-h">
        <div>
          <div className="title">Billing &amp; plan</div>
          <div className="sub">Manage your subscription and usage limits.</div>
        </div>
        {/* Current plan badge */}
        <div style={{ marginLeft: 'auto' }}>
          <Badge tone={currentPlan === 'free' ? 'neutral' : 'brand'} style={{ textTransform: 'capitalize' }}>
            {currentPlan ?? 'free'} plan
          </Badge>
        </div>
      </div>

      <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ── Live usage widget ─────────────────────────────────────────── */}
        {usage && (
          <div style={{
            padding: '14px 16px',
            background: 'var(--bg-sunken)',
            borderRadius: 10,
            border: '1px solid var(--border-1)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              This month&rsquo;s usage
            </div>

            {/* Monthly calls */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                  MCP calls this month
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 12.5,
                  color: monthlyAtLimit ? 'var(--red-600, #dc2626)' : monthlyNearLimit ? 'var(--amber-600, #d97706)' : 'var(--fg-1)',
                  fontWeight: 600,
                }}>
                  {(monthlyUsed ?? 0).toLocaleString()}
                  {monthlyCap != null ? ` / ${monthlyCap.toLocaleString()}` : ''}
                </span>
              </div>
              {monthlyCap != null && (
                <div style={{ height: 4, borderRadius: 3, background: 'var(--bg-page, #f8fafc)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, monthlyPct * 100)}%`,
                    background: monthlyAtLimit ? 'var(--red-500, #ef4444)' : monthlyNearLimit ? 'var(--amber-500, #f59e0b)' : 'var(--brand)',
                    borderRadius: 3,
                    transition: 'width 0.4s',
                  }} />
                </div>
              )}
              {monthlyCap != null && (
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--fg-4)', marginTop: 4 }}>
                  {monthlyCap - (monthlyUsed ?? 0) > 0
                    ? `${(monthlyCap - (monthlyUsed ?? 0)).toLocaleString()} calls remaining · resets ${new Date(usage.monthly.resets_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : 'Monthly quota exhausted · resets ' + new Date(usage.monthly.resets_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
              )}
            </div>

            {/* Daily burst calls */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                  Calls today (burst cap)
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 12.5,
                  color: dailyAtLimit ? 'var(--red-600, #dc2626)' : dailyNearLimit ? 'var(--amber-600, #d97706)' : 'var(--fg-1)',
                  fontWeight: 600,
                }}>
                  {(dailyUsed ?? 0).toLocaleString()}
                  {dailyCap != null ? ` / ${dailyCap.toLocaleString()}` : ''}
                </span>
              </div>
              {dailyCap != null && (
                <div style={{ height: 4, borderRadius: 3, background: 'var(--bg-page, #f8fafc)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, dailyPct * 100)}%`,
                    background: dailyAtLimit ? 'var(--red-500, #ef4444)' : dailyNearLimit ? 'var(--amber-500, #f59e0b)' : 'var(--mint-500, #10b981)',
                    borderRadius: 3,
                    transition: 'width 0.4s',
                  }} />
                </div>
              )}
              {dailyCap != null && (
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--fg-4)', marginTop: 4 }}>
                  Resets at midnight UTC
                </div>
              )}
            </div>

            {/* Upgrade nudge at ≥80% monthly usage */}
            {(monthlyNearLimit || monthlyAtLimit) && currentPlan !== 'enterprise' && (
              <div style={{ paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
                <a href="/pricing" style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--brand)', textDecoration: 'none' }}>
                  Upgrade your plan →
                </a>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)', marginLeft: 8 }}>
                  for a higher monthly limit
                </span>
              </div>
            )}
          </div>
        )}

        {isOnPaidPlan ? (
          /* Paid plan — show active subscription summary + portal button */
          <div style={{
            padding: '16px',
            background: 'var(--bg-sunken)',
            borderRadius: 10,
            border: '1px solid var(--border-1)',
          }}>
            {/* Plan heading row */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
            }}>
              <div>
                <div style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13.5,
                  fontWeight: 600,
                  color: 'var(--fg-1)',
                  marginBottom: 4,
                }}>
                  You&apos;re on the{' '}
                  <span style={{ textTransform: 'capitalize' }}>{currentPlan}</span> plan.
                </div>
                <div style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12.5,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  Manage your subscription, update your payment method, download invoices, or cancel — all from the Stripe billing portal.
                </div>
              </div>

              {/* Portal CTA */}
              <div style={{ flexShrink: 0 }}>
                <Btn
                  variant="secondary"
                  icon="refresh"
                  onClick={handleOpenPortal}
                  disabled={openingPortal}
                >
                  {openingPortal ? 'Opening portal…' : 'Manage billing'}
                </Btn>
              </div>
            </div>

            {/* Divider */}
            <div style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: '1px solid var(--border-1)',
              display: 'flex',
              gap: 20,
              flexWrap: 'wrap',
            }}>
              {/* What you can do in the portal */}
              {[
                'View & download invoices',
                'Update payment method',
                'Change or cancel plan',
              ].map(item => (
                <div key={item} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}>
                  <Icon name="check" size={12} color="var(--mint-600)" />
                  <span style={{
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12,
                    color: 'var(--fg-3)',
                  }}>
                    {item}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Free plan — show upgrade cards */
          <>
            {/* Interval toggle */}
            <div style={{ display: 'flex', gap: 0, alignSelf: 'flex-start', borderRadius: 8, border: '1px solid var(--border-1)', overflow: 'hidden' }}>
              {[{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Annual (save 20%)' }].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setInterval(opt.value)}
                  style={{
                    padding: '6px 14px',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12.5,
                    fontWeight: 500,
                    border: 'none',
                    cursor: 'pointer',
                    background: interval === opt.value ? 'var(--brand)' : 'transparent',
                    color: interval === opt.value ? '#fff' : 'var(--fg-2)',
                    transition: 'background 120ms, color 120ms',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Plan upgrade cards */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {BILLING_PLANS.map(plan => {
                const price = interval === 'year' ? plan.yearlyMonthlyPrice : plan.monthlyPrice;
                const isCurrentPlanMatch = currentPlan === plan.id;
                const isLoading = upgrading === plan.id;
                return (
                  <div
                    key={plan.id}
                    style={{
                      flex: '1 1 220px',
                      padding: '16px',
                      borderRadius: 10,
                      border: plan.highlighted
                        ? '2px solid var(--brand)'
                        : '1px solid var(--border-1)',
                      background: plan.highlighted ? 'var(--brand-soft)' : 'var(--bg-sunken)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    {/* Plan name + price */}
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{
                          fontFamily: 'var(--font-sans)',
                          fontSize: 14,
                          fontWeight: 700,
                          color: 'var(--fg-1)',
                        }}>
                          {plan.name}
                        </span>
                        {plan.highlighted && (
                          <Badge tone="brand">Most popular</Badge>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                        <span style={{
                          fontFamily: 'var(--font-sans)',
                          fontSize: 26,
                          fontWeight: 700,
                          color: 'var(--fg-1)',
                          lineHeight: 1,
                        }}>
                          ${price}
                        </span>
                        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                          /month
                        </span>
                      </div>
                      {interval === 'year' && (
                        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>
                          Billed ${plan.yearlyAnnualTotal}/year
                        </div>
                      )}
                    </div>

                    {/* Feature list */}
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {plan.features.map(feat => (
                        <li key={feat} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <Icon name="check" size={12} color="var(--mint-600)" style={{ flexShrink: 0, marginTop: 2 }} />
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.4 }}>
                            {feat}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* CTA */}
                    <Btn
                      variant={plan.highlighted ? 'primary' : 'secondary'}
                      onClick={() => handleUpgrade(plan.id)}
                      disabled={isCurrentPlanMatch || isLoading || upgrading !== null}
                      style={{ marginTop: 'auto' }}
                    >
                      {isLoading
                        ? 'Redirecting…'
                        : isCurrentPlanMatch
                        ? 'Current plan'
                        : `Upgrade to ${plan.name}`}
                    </Btn>
                  </div>
                );
              })}
            </div>

            <p style={{
              margin: 0,
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
              color: 'var(--fg-3)',
              lineHeight: 1.5,
            }}>
              You&apos;ll be redirected to Stripe to complete payment securely.
              Cancel any time — you keep access until the end of your billing period.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export function SettingsPage({ user, workspace }) {

  return (
    <div className="page">
      <PageHeader title="Settings" sub="Profile, workspace, and account." />

      {/* Profile section — display name + read-only email */}
      <ProfileSection
        displayName={user?.displayName ?? ''}
        email={user?.email ?? ''}
      />

      {/* Password change section */}
      <PasswordSection />

      {/* Billing section — current plan + upgrade */}
      <BillingSection currentPlan={workspace?.plan ?? 'free'} />

      {/* Workspace section */}
      <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
        <div className="card-h"><div className="title">Workspace</div></div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field">
            <label
              htmlFor="settings-workspace-name"
              style={{
                display: 'block',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--fg-2)',
                marginBottom: 6,
              }}
            >
              Workspace name
            </label>
            <input
              id="settings-workspace-name"
              className="input"
              defaultValue={workspace?.slug ?? ''}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary">Cancel</Btn>
            <Btn variant="primary">Save changes</Btn>
          </div>
        </div>
      </div>

      {/* Delete account — danger zone */}
      <DeleteAccountSection email={user?.email ?? ''} />
    </div>
  );
}

/* ---------------- Security ---------------- */

/* ── ActiveSessionsSection ───────────────────────────────────────────────── */

/**
 * Formats an ISO timestamp as a compact relative label for "last active" display.
 * Falls back to an absolute date string for timestamps older than 7 days.
 */
function formatSessionAge(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Returns a CSS class suffix for the device icon based on OS label.
 */
function deviceIcon(os) {
  if (/iphone|ipad/i.test(os)) return 'smartphone';
  if (/android/i.test(os)) return 'smartphone';
  if (/windows|macos|linux|chrome os/i.test(os)) return 'monitor';
  return 'globe';
}

/**
 * ActiveSessionsSection — lists all active Supabase Auth sessions for the
 * current user and provides a "Sign out all other sessions" action.
 *
 * Sessions are fetched client-side from GET /api/security/sessions on mount.
 * The DELETE /api/security/sessions endpoint revokes all refresh tokens except
 * the current session, so the user stays logged in on this device.
 */
function ActiveSessionsSection() {
  const [sessions, setSessions] = useState(null);   // null = loading
  const [fetchErr, setFetchErr] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  const { toast } = useToast();

  // Fetch sessions on first render
  const loadSessions = async () => {
    setFetchErr(null);
    setSessions(null);
    try {
      const res = await fetch('/api/security/sessions');
      if (!res.ok) {
        let msg = 'Failed to load sessions.';
        try { const d = await res.json(); if (typeof d?.error === 'string') msg = d.error; } catch { /* ignore */ }
        setFetchErr(msg);
        return;
      }
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {
      setFetchErr('Network error — please try again.');
    }
  };

  // Load on mount
  useEffect(() => { loadSessions(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const otherSessionCount = sessions
    ? sessions.filter(s => !s.isCurrent).length
    : 0;

  const handleSignOutOthers = async () => {
    if (signingOut || otherSessionCount === 0) return;
    setSigningOut(true);
    try {
      const res = await fetch('/api/security/sessions', { method: 'DELETE' });
      if (!res.ok) {
        let msg = 'Failed to sign out other sessions.';
        try { const d = await res.json(); if (typeof d?.error === 'string') msg = d.error; } catch { /* ignore */ }
        toast({ message: msg, variant: 'error' });
        return;
      }
      // Remove all non-current sessions from local state
      setSessions(prev => (prev ?? []).filter(s => s.isCurrent));
      toast({
        message: otherSessionCount === 1
          ? 'Signed out 1 other session.'
          : `Signed out ${otherSessionCount} other sessions.`,
        variant: 'success',
      });
    } catch {
      toast({ message: 'Network error — please try again.', variant: 'error' });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-h">
        <div>
          <div className="title">Active sessions</div>
          <div className="sub">
            Devices and browsers currently signed into your account.
          </div>
        </div>
        {otherSessionCount > 0 && (
          <div style={{ marginLeft: 'auto' }}>
            <Btn
              variant="danger"
              size="sm"
              onClick={handleSignOutOthers}
              disabled={signingOut}
            >
              {signingOut
                ? 'Signing out…'
                : `Sign out ${otherSessionCount === 1 ? 'other session' : `${otherSessionCount} other sessions`}`}
            </Btn>
          </div>
        )}
      </div>

      {/* Loading skeleton */}
      {sessions === null && !fetchErr && (
        <div style={{ padding: '20px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[1, 2].map(i => (
            <div key={i} style={{
              height: 48, borderRadius: 8,
              background: 'var(--ink-100)',
              animation: 'pulse 1.4s ease-in-out infinite',
              opacity: 0.6,
            }} />
          ))}
          <style>{`@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.9} }`}</style>
        </div>
      )}

      {/* Fetch error */}
      {fetchErr && (
        <div style={{
          margin: '0 20px 16px',
          padding: '10px 14px',
          background: 'var(--red-100)',
          border: '1px solid rgba(229,72,77,0.25)',
          borderRadius: 8,
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          color: 'var(--red-700)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <span>{fetchErr}</span>
          <Btn variant="secondary" size="sm" onClick={loadSessions}>Retry</Btn>
        </div>
      )}

      {/* Sessions list */}
      {sessions !== null && sessions.length === 0 && (
        <div className="empty">
          <div className="ico"><Icon name="shield" size={20} /></div>
          <h3>No active sessions found</h3>
          <p>Your session data could not be retrieved.</p>
        </div>
      )}

      {sessions !== null && sessions.length > 0 && (
        <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Device</th>
              <th>IP address</th>
              <th>Signed in</th>
              <th>Last active</th>
              <th style={{ minWidth: 80 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map(session => (
              <tr key={session.id}>
                {/* Device */}
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8,
                      background: 'var(--bg-sunken)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Icon name={deviceIcon(session.os)} size={16} color="var(--fg-3)" />
                    </div>
                    <div>
                      <div style={{
                        fontFamily: 'var(--font-sans)', fontSize: 13.5,
                        fontWeight: 600, color: 'var(--fg-1)',
                      }}>
                        {session.browser}
                      </div>
                      <div style={{
                        fontFamily: 'var(--font-sans)', fontSize: 12,
                        color: 'var(--fg-3)', marginTop: 1,
                      }}>
                        {session.os}
                      </div>
                    </div>
                  </div>
                </td>

                {/* IP address */}
                <td>
                  <code style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12.5,
                    color: 'var(--fg-3)',
                  }}>
                    {session.ip ?? '—'}
                  </code>
                </td>

                {/* Signed in (created_at) */}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'var(--fg-3)',
                  }}>
                    {formatSessionAge(session.createdAt)}
                  </span>
                </td>

                {/* Last active (refreshed_at or updated_at) */}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'var(--fg-3)',
                  }}>
                    {formatSessionAge(session.lastActiveAt)}
                  </span>
                </td>

                {/* Status badge */}
                <td>
                  {session.isCurrent ? (
                    <Badge tone="live" dot="live">This device</Badge>
                  ) : (
                    <Badge tone="neutral">Active</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 25;

/**
 * Formats an ISO timestamp as a compact absolute datetime.
 * e.g. "24 May 2026 · 14:32"
 */
function formatAuditTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const datePart = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${datePart} · ${timePart}`;
}

/**
 * AuditTable — renders a page of audit log entries as a table.
 *
 * Columns: Tool, Inbox, API Key, Timestamp, Status
 */
function AuditTable({ entries }) {
  if (entries.length === 0) {
    return (
      <div className="empty">
        <div className="ico"><Icon name="shield" size={20} /></div>
        <h3>No MCP tool calls yet</h3>
        <p>
          Every tool call made through the MCP endpoint will appear here with its
          status and the API key used.
        </p>
      </div>
    );
  }

  return (
    <div className="tbl-wrap">
    <table className="tbl">
      <thead>
        <tr>
          <th>Tool</th>
          <th>Inbox</th>
          <th>API key</th>
          <th>Timestamp</th>
          <th>Status</th>
          <th style={{ minWidth: 64 }}>Duration</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            {/* Tool name */}
            <td>
              <code
                className="mono"
                style={{ color: 'var(--cobalt-700)', fontWeight: 500 }}
              >
                {entry.tool}
              </code>
            </td>

            {/* Inbox */}
            <td>
              {entry.inbox ? (
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                  {entry.inbox}
                </span>
              ) : (
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-4)' }}>
                  —
                </span>
              )}
            </td>

            {/* API key */}
            <td>
              {entry.apiKeyName ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)', fontWeight: 500 }}>
                    {entry.apiKeyName}
                  </span>
                  {entry.apiKeyPrefix && (
                    <code
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--fg-4)',
                      }}
                    >
                      mcpe_{entry.apiKeyPrefix}…
                    </code>
                  )}
                </div>
              ) : (
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-4)' }}>
                  —
                </span>
              )}
            </td>

            {/* Timestamp */}
            <td style={{ whiteSpace: 'nowrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>
                {formatAuditTimestamp(entry.createdAt)}
              </span>
            </td>

            {/* Status badge */}
            <td>
              {entry.status === 'success' ? (
                <Badge tone="live" dot="live">Success</Badge>
              ) : entry.status === 'rate_limited' ? (
                <Badge tone="amber" dot="amber">Rate limited</Badge>
              ) : (
                <div>
                  <Badge tone="red" dot="red">Error</Badge>
                  {entry.errorCode && (
                    <div style={{ marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--red-700)' }}>
                      {entry.errorCode}
                    </div>
                  )}
                </div>
              )}
            </td>

            {/* Duration */}
            <td>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}>
                {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

/**
 * SecurityPage — active sessions list + paginated audit log of MCP tool calls.
 *
 * Props:
 *   auditLog — {
 *     entries: AuditEntry[];   // first page, pre-fetched server-side
 *     total: number;           // total row count for pagination
 *     page: number;            // current page (always 0 from server)
 *     pageSize: number;        // rows per page (always 25)
 *   }
 *
 * Subsequent pages are fetched client-side from GET /api/security/audit-log.
 */
export function SecurityPage({ auditLog }) {
  const initialEntries = auditLog?.entries ?? [];
  const initialTotal   = auditLog?.total    ?? 0;
  const pageSize       = auditLog?.pageSize ?? PAGE_SIZE;

  const [entries,  setEntries]  = useState(initialEntries);
  const [total,    setTotal]    = useState(initialTotal);
  const [page,     setPage]     = useState(0);
  const [loading,  setLoading]  = useState(false);
  const [fetchErr, setFetchErr] = useState(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /**
   * Fetches a page from the API and updates local state.
   * Does nothing when already loading or when the page hasn't changed.
   */
  const loadPage = async (nextPage) => {
    if (loading) return;
    setLoading(true);
    setFetchErr(null);
    try {
      const res = await fetch(
        `/api/security/audit-log?page=${nextPage}&pageSize=${pageSize}`,
      );
      if (!res.ok) {
        let msg = 'Failed to load audit log.';
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') msg = data.error;
        } catch { /* ignore */ }
        setFetchErr(msg);
        return;
      }
      const data = await res.json();
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
      setPage(nextPage);
    } catch {
      setFetchErr('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handlePrev = () => { if (page > 0) loadPage(page - 1); };
  const handleNext = () => { if (page < totalPages - 1) loadPage(page + 1); };

  const rangeStart = total === 0 ? 0 : page * pageSize + 1;
  const rangeEnd   = Math.min((page + 1) * pageSize, total);

  return (
    <div className="page">
      <PageHeader
        title="Security"
        sub="Active sessions and audit trail of every MCP tool call."
      />

      {/* Active sessions — loaded client-side */}
      <ActiveSessionsSection />

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <div>
            <div className="title">Audit log</div>
            <div className="sub">
              {total > 0
                ? `Showing ${rangeStart}–${rangeEnd} of ${total.toLocaleString()} tool calls`
                : 'MCP tool calls across all API keys and inboxes'}
            </div>
          </div>
          {/* Pagination controls — only shown when there is more than one page */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <span style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                color: 'var(--fg-3)',
                userSelect: 'none',
              }}>
                Page {page + 1} of {totalPages}
              </span>
              <Btn
                variant="secondary"
                size="sm"
                icon="chevron"
                onClick={handlePrev}
                disabled={page === 0 || loading}
                title="Previous page"
              >
                {''}
              </Btn>
              <Btn
                variant="secondary"
                size="sm"
                icon="chevron"
                onClick={handleNext}
                disabled={page >= totalPages - 1 || loading}
                title="Next page"
              >
                {''}
              </Btn>
            </div>
          )}
        </div>

        {/* Loading overlay — subtle opacity shift while fetching subsequent pages */}
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 150ms' }}>
          <AuditTable entries={entries} />
        </div>

        {/* Fetch error */}
        {fetchErr && (
          <div style={{
            margin: '12px 20px',
            padding: '10px 14px',
            background: 'var(--red-100)',
            border: '1px solid rgba(229,72,77,0.25)',
            borderRadius: 8,
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            color: 'var(--red-700)',
          }}>
            {fetchErr}
          </div>
        )}

        {/* Bottom pagination — mirrors the header controls for long tables */}
        {totalPages > 1 && entries.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderTop: '1px solid var(--border-1)',
          }}>
            <span style={{
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
              color: 'var(--fg-3)',
            }}>
              {rangeStart}–{rangeEnd} of {total.toLocaleString()} results
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn
                variant="secondary"
                size="sm"
                onClick={handlePrev}
                disabled={page === 0 || loading}
              >
                ← Previous
              </Btn>
              <Btn
                variant="secondary"
                size="sm"
                onClick={handleNext}
                disabled={page >= totalPages - 1 || loading}
              >
                Next →
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
