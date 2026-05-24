'use client';

import { useState } from 'react';
import { Icon, Badge, Btn, Avatar, ProviderLogo } from '../Primitives';

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

/* ---------------- Overview ---------------- */
export function OverviewPage({ inboxes, activity, onConnect }) {
  return (
    <div className="page">
      <PageHeader
        title="Overview"
        sub="Real-time view of your connected inboxes and MCP traffic."
        action={<Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>}
      />

      <div className="stat-grid">
        <div className="stat">
          <div className="label">Inboxes connected</div>
          <div className="value">{inboxes.filter(i => i.status === "live").length}<span style={{fontSize:16, color:"var(--fg-3)", fontWeight:400}}> / 10</span></div>
          <div className="delta">+1 this week</div>
        </div>
        <div className="stat">
          <div className="label">MCP calls (30d)</div>
          <div className="value">12,484</div>
          <div className="delta">+18.2% vs. last 30d</div>
        </div>
        <div className="stat">
          <div className="label">Avg. response time</div>
          <div className="value">214<span style={{fontSize:16, color:"var(--fg-3)", fontWeight:400}}> ms</span></div>
          <div className="delta neg">+24ms vs. last 30d</div>
        </div>
        <div className="stat">
          <div className="label">Plan usage</div>
          <div className="value">62<span style={{fontSize:16, color:"var(--fg-3)", fontWeight:400}}>%</span></div>
          <div className="delta">12.5k / 20k calls</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, marginTop: 16 }}>
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
            {activity.map((a, i) => (
              <div className="act-row" key={i}>
                <span className={"dot " + (a.ok ? "live" : "red")}></span>
                <span className="tool">{a.tool}()</span>
                <span className="meta">· {a.account}</span>
                <span className="time">{a.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

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

/* ---------------- Inboxes ---------------- */
export function InboxesPage({ inboxes, onConnect, onRemove }) {
  return (
    <div className="page">
      <PageHeader
        title="Inboxes"
        sub="Email accounts your agents can read and send through."
        action={<Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>}
      />
      <div className="card">
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
                  {ib.status === "live"    ? <Badge tone="live"  dot="live">Connected</Badge> : null}
                  {ib.status === "expiring"? <Badge tone="amber" dot="amber">Token expiring</Badge> : null}
                  {ib.status === "error"   ? <Badge tone="red"   dot="red">Auth failed</Badge> : null}
                </td>
                <td className="mono">{ib.calls.toLocaleString()}</td>
                <td className="right">
                  <Btn variant="ghost" size="sm" icon="refresh">{""}</Btn>
                  <Btn variant="ghost" size="sm" icon="trash" onClick={() => onRemove(ib.id)}>{""}</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {inboxes.length === 0 ? (
          <div className="empty">
            <div className="ico"><Icon name="inbox" size={20} /></div>
            <h3>No inboxes connected</h3>
            <p>Connect Gmail, Outlook, or any IMAP provider to give your agents access.</p>
            <div style={{marginTop: 8}}>
              <Btn variant="primary" icon="plus" onClick={onConnect}>Connect inbox</Btn>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- API Keys ---------------- */
export function KeysPage({ keys, onCreate, onRevoke }) {
  const [reveal, setReveal] = useState({});
  const [copied, setCopied] = useState(null);
  const copy = (k) => { navigator.clipboard?.writeText(k.token); setCopied(k.id); setTimeout(() => setCopied(null), 1400); };

  return (
    <div className="page">
      <PageHeader
        title="API keys"
        sub="Used by MCP clients to authenticate against mcpemails.com."
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <a className="btn btn-secondary" href="authorize.html">
              <Icon name="shield" size={14} className="ico"/>
              Simulate agent authorize
            </a>
            <Btn variant="primary" icon="plus" onClick={onCreate}>New key</Btn>
          </div>
        }
      />
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Scopes</th>
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
                    <code className="mono" style={{ background: "var(--bg-sunken)", padding: "3px 8px", borderRadius: 6 }}>
                      {reveal[k.id] ? k.token : k.token.slice(0, 9) + "•••••••••••••" + k.token.slice(-4)}
                    </code>
                    <Btn variant="ghost" size="sm" icon={reveal[k.id] ? "eyeoff" : "eye"} onClick={() => setReveal(r => ({...r, [k.id]: !r[k.id]}))}>{""}</Btn>
                    <Btn variant="ghost" size="sm" icon={copied === k.id ? "check" : "copy"} onClick={() => copy(k)}>{""}</Btn>
                  </div>
                </td>
                <td>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {k.scopes.map(s => <Badge key={s} tone="neutral">{s}</Badge>)}
                  </div>
                </td>
                <td className="mono">{k.lastUsed}</td>
                <td className="right">
                  <Btn variant="danger" size="sm" onClick={() => onRevoke(k.id)}>Revoke</Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <div>
            <div className="title">Connect from Claude Desktop</div>
            <div className="sub">Paste this snippet into your <code className="t-code-inline">~/.claude/mcp.json</code></div>
          </div>
        </div>
        <div className="card-body">
          <pre style={{ margin: 0, background: "var(--bg-inverse)", color: "#E6EAFB", borderRadius: 10, padding: "16px 18px", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.7, overflow: "auto" }}>
{`{
  "mcpServers": {
    "mcpemails": {
      "url": "https://mcp.mcpemails.com/v1",
      "auth": { "type": "bearer", "token": "mcpe_live_••••" }
    }
  }
}`}
          </pre>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Usage ---------------- */
export function UsagePage() {
  const tools = [
    { name: "list_inbox",     calls: 5421, pct: 43 },
    { name: "read_email",     calls: 3208, pct: 26 },
    { name: "search_emails",  calls: 2104, pct: 17 },
    { name: "send_email",     calls: 1188, pct:  9 },
    { name: "reply_to_email", calls:  563, pct:  5 },
  ];
  return (
    <div className="page">
      <PageHeader title="Usage" sub="MCP tool calls and billing meter for this month." />
      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <div className="stat">
          <div className="label">Calls this month</div>
          <div className="value">12,484</div>
          <div className="delta">Resets in 9 days</div>
        </div>
        <div className="stat">
          <div className="label">Plan limit</div>
          <div className="value">20,000</div>
          <div className="delta">Pro plan · $29/mo</div>
        </div>
        <div className="stat">
          <div className="label">Overage</div>
          <div className="value">$0</div>
          <div className="delta">$0.001 per call after limit</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <div className="title">Calls per day</div>
          <div className="grow"></div>
          <Btn variant="secondary" size="sm" icon="download">Export CSV</Btn>
        </div>
        <div className="card-body"><UsageBars /></div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h"><div className="title">Calls by tool</div></div>
        <table className="tbl">
          <thead><tr><th>Tool</th><th>Calls</th><th>Share</th><th></th></tr></thead>
          <tbody>
            {tools.map(t => (
              <tr key={t.name}>
                <td><code className="mono" style={{ color: "var(--cobalt-700)" }}>{t.name}</code></td>
                <td className="mono">{t.calls.toLocaleString()}</td>
                <td className="mono">{t.pct}%</td>
                <td style={{ width: 240 }}>
                  <div style={{ height: 6, borderRadius: 3, background: "var(--ink-100)", overflow: "hidden" }}>
                    <div style={{ width: t.pct + "%", height: "100%", background: "var(--cobalt-500)" }}></div>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Settings ---------------- */
export function SettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Settings" sub="Workspace name, billing, and team." />
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-h"><div className="title">Workspace</div></div>
        <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field">
            <label>Workspace name</label>
            <input className="input" defaultValue="jordan-personal" />
          </div>
          <div className="field">
            <label>Region</label>
            <select className="input" defaultValue="eu-fra">
              <option value="us-iad">US · N. Virginia</option>
              <option value="eu-fra">EU · Frankfurt</option>
              <option value="ap-syd">AP · Sydney</option>
            </select>
            <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--fg-3)" }}>Where your encrypted credentials are stored.</span>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary">Cancel</Btn>
            <Btn variant="primary">Save changes</Btn>
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640, marginTop: 14, borderColor: "rgba(229,72,77,0.25)" }}>
        <div className="card-h" style={{ borderColor: "rgba(229,72,77,0.25)" }}>
          <div>
            <div className="title" style={{ color: "var(--red-700)" }}>Delete workspace</div>
            <div className="sub">All credentials and API keys will be revoked immediately. This cannot be undone.</div>
          </div>
        </div>
        <div className="card-body" style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="danger">Delete workspace</Btn>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Security ---------------- */
export function SecurityPage() {
  const events = [
    { t: "2 min ago",    e: "API key mcpe_live_a3f… used", ip: "from 10.0.4.18 (Claude Desktop)" },
    { t: "1 hour ago",   e: "OAuth token refreshed for work-gmail", ip: "automatic" },
    { t: "5 hours ago",  e: "New API key created", ip: "by jordan@stripe.com" },
    { t: "Yesterday",    e: "Inbox personal-gmail connected", ip: "OAuth2 · scopes: gmail.modify, gmail.send" },
    { t: "3 days ago",   e: "Password changed", ip: "" },
  ];
  return (
    <div className="page">
      <PageHeader title="Security" sub="Audit trail and credential management." />
      <div className="card" style={{ maxWidth: 760 }}>
        <div className="card-h"><div className="title">Audit log</div></div>
        <div>
          {events.map((ev, i) => (
            <div className="act-row" key={i}>
              <Icon name="shield" size={14} color="var(--fg-3)" />
              <div>
                <div style={{ fontFamily: "var(--font-sans)", fontSize: 13.5, color: "var(--fg-1)" }}>{ev.e}</div>
                {ev.ip ? <div className="meta" style={{ fontSize: 12 }}>{ev.ip}</div> : null}
              </div>
              <span className="time">{ev.t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
