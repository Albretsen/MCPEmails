'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { trackProductEvent, scopeProfile } from '@/lib/analytics.mjs';
import { Icon, Badge, Btn, Avatar, ProviderLogo } from '../Primitives';
import { useAppLocale } from '../i18n/AppLocaleProvider';
import { routing } from '@/i18n/routing';
import { CLIENT_LOGOS } from './clientLogos';
import { useToast } from './Toast';
import SignatureRichEditor from './SignatureRichEditor';
import { sanitizeSignatureHtml } from '@/lib/sanitizeSignatureHtml';
import { ApprovalsPanel } from './ApprovalsPanel';

/* Pages.jsx: Overview, Inboxes, Keys, Usage, Settings, Security. */

// Display names for the inbox Provider column, keyed by the provider/brand
// value (generic IMAP is 'imap'; branded IMAP surfaces its service). Avoids the
// naive CSS capitalize that would render "Imap" / "ICloud".
const PROVIDER_LABELS = {
  gmail: 'Gmail',
  outlook: 'Outlook',
  fastmail: 'Fastmail',
  imap: 'IMAP',
  icloud: 'iCloud',
  yahoo: 'Yahoo',
  zoho: 'Zoho',
  yandex: 'Yandex',
};

// Mirrors the server-side Compatibility Profile contract. The dashboard does
// not run mailbox probes: these are safe connector semantics, not customer
// email data. Branded app-password providers all use the IMAP baseline.
function compatibilityForInbox(provider) {
  if (provider === 'gmail') {
    return {
      status: 'Compatible with differences',
      tone: 'amber',
      profile: 'gmail-v1',
      notes: [
        'Uses labels rather than folders.',
        'Moving adds a label and removes INBOX; other labels remain.',
        'Body search is whole-message search.',
      ],
    };
  }
  if (provider === 'outlook') {
    return {
      status: 'Planned connector',
      tone: 'neutral',
      profile: 'outlook-v1',
      notes: [
        'Uses folders and Microsoft Graph search semantics.',
        'Flagged search is unavailable through the normalized search path.',
      ],
    };
  }
  return {
    status: 'Compatible with differences',
    tone: 'amber',
    profile: 'imap-baseline-v1',
    notes: [
      'Uses the IMAP protocol baseline; individual servers can differ.',
      'Attachment-only search is unavailable.',
      'Move can fall back to copy and delete when MOVE is unavailable.',
    ],
  };
}

export function ApprovalsPage({ userRole }) {
  return <ApprovalsPanel userRole={userRole} />;
}

// Rich-text tag handlers shared across pages (inline code + bold).
const RICH = {
  code: (chunks) => <code className="t-code-inline">{chunks}</code>,
  b: (chunks) => <strong>{chunks}</strong>,
};

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
 * Copyable value block. Shows `value` in a dark mono panel with a copy button
 * that flips to a check for 2s on success. Used to make the MCP endpoint URL
 * (and config snippets) trivial to copy. `multiline` allows code blocks to wrap
 * and preserve whitespace.
 */
function CopyField({ value, label, multiline = false, onCopy }) {
  const t = useTranslations('dashboard');
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      onCopy?.();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <div>
      {label ? (
        <div style={{
          fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600,
          color: 'var(--fg-3)', marginBottom: 6, letterSpacing: '0.01em',
        }}>
          {label}
        </div>
      ) : null}
      <div style={{
        position: 'relative',
        background: 'var(--bg-inverse)', borderRadius: 10,
        padding: multiline ? '14px 50px 14px 16px' : '0 50px 0 16px',
        display: 'flex', alignItems: 'center',
        minHeight: multiline ? undefined : 46,
      }}>
        <code style={{
          fontFamily: 'var(--font-mono)', fontSize: 13,
          color: '#E6EAFB', lineHeight: 1.6,
          wordBreak: 'break-all',
          whiteSpace: multiline ? 'pre-wrap' : 'nowrap',
          overflow: multiline ? 'visible' : 'hidden',
          textOverflow: multiline ? 'clip' : 'ellipsis',
          display: 'block', flex: 1,
        }}>
          {value}
        </code>
        <button
          onClick={copy}
          title={copied ? t('copy.copied') : t('copy.copy')}
          aria-label={copied ? t('copy.copied') : t('copy.copyAria')}
          style={{
            position: 'absolute', right: 10, top: multiline ? 12 : '50%',
            transform: multiline ? 'none' : 'translateY(-50%)',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: copied ? 'var(--mint-500)' : 'rgba(230,234,251,0.55)',
            padding: 6, display: 'flex', alignItems: 'center',
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={15} color={copied ? 'var(--mint-500)' : 'rgba(230,234,251,0.55)'} />
        </button>
      </div>
    </div>
  );
}

/**
 * Official brand logo for an MCP client. Renders the client's logo glyph in
 * white on a rounded square tile in the client's brand colour. `logo` is a key
 * into CLIENT_LOGOS (official path data from Simple Icons / Codicons / Lobe).
 */
function ClientLogo({ color, logo, size = 34 }) {
  const g = CLIENT_LOGOS[logo];
  const glyph = Math.round(size * 0.56);
  return (
    <div style={{
      width: size, height: size, borderRadius: 9,
      background: color,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      {g ? (
        <svg width={glyph} height={glyph} viewBox={g.viewBox} fill="#fff" aria-hidden="true">
          <path d={g.d} />
        </svg>
      ) : null}
    </div>
  );
}

/**
 * Supported MCP clients, ordered by real-world usage (Claude first).
 *
 * Only clients verified to support connecting to a REMOTE MCP server BY URL
 * are listed, each with steps read from the client's current official docs.
 *
 * `oauth: true`  → the client does the OAuth browser flow; no API key needed.
 * `oauth: false` → authenticate with a bearer API key (shows the key CTA).
 * `steps`  → imperative setup steps (the live MCP URL is shown above them).
 * `config` → copyable config snippet built from the live MCP URL (when the
 *            client is configured via a file rather than a UI form).
 * `note`   → optional caveat shown beneath the steps.
 * `guide`  → official documentation URL for connecting a remote MCP server.
 */
const MCP_CLIENTS = [
  {
    k: 'claude',
    name: 'Claude',
    sub: 'claude.ai · Desktop',
    color: '#D97757',
    logo: 'claude',
    oauth: true,
    guide: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
    stepKeys: ['clients.claude.step1', 'clients.claude.step2', 'clients.claude.step3', 'clients.claude.step4'],
  },
  {
    k: 'chatgpt',
    name: 'ChatGPT',
    sub: 'Apps · dev mode',
    color: '#000000',
    logo: 'chatgpt',
    oauth: true,
    guide: 'https://help.openai.com/en/articles/12584461',
    stepKeys: ['clients.chatgpt.step1', 'clients.chatgpt.step2', 'clients.chatgpt.step3', 'clients.chatgpt.step4'],
    noteKey: 'clients.chatgpt.note',
  },
  {
    k: 'cursor',
    name: 'Cursor',
    sub: 'mcp.json',
    color: '#000000',
    logo: 'cursor',
    oauth: true,
    guide: 'https://cursor.com/docs/mcp',
    stepKeys: ['clients.cursor.step1', 'clients.cursor.step2', 'clients.cursor.step3'],
    config: (url) => `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "mcpemails": {
      "url": "${url}"
    }
  }
}`,
  },
  {
    k: 'vscode',
    name: 'VS Code',
    sub: 'Copilot agent',
    color: '#0078D4',
    logo: 'vscode',
    oauth: true,
    guide: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    stepKeys: ['clients.vscode.step1', 'clients.vscode.step2', 'clients.vscode.step3'],
    config: (url) => `// .vscode/mcp.json
{
  "servers": {
    "mcpemails": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
  },
  {
    k: 'cline',
    name: 'Cline',
    sub: 'Remote Servers',
    color: '#18181B',
    logo: 'cline',
    oauth: false,
    needsKey: true,
    guide: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    stepKeys: ['clients.cline.step1', 'clients.cline.step2', 'clients.cline.step3', 'clients.cline.step4'],
  },
  {
    k: 'windsurf',
    name: 'Windsurf',
    sub: 'Cascade',
    color: '#0B100F',
    logo: 'windsurf',
    oauth: true,
    guide: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    stepKeys: ['clients.windsurf.step1', 'clients.windsurf.step2', 'clients.windsurf.step3'],
    config: (url) => `// ~/.codeium/windsurf/mcp_config.json
{
  "mcpServers": {
    "mcpemails": {
      "serverUrl": "${url}"
    }
  }
}`,
  },
  {
    k: 'gemini',
    name: 'Gemini CLI',
    sub: 'settings.json',
    color: '#8E75B2',
    logo: 'gemini',
    oauth: true,
    guide: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
    stepKeys: ['clients.gemini.step1', 'clients.gemini.step2', 'clients.gemini.step3'],
    config: (url) => `// ~/.gemini/settings.json
{
  "mcpServers": {
    "mcpemails": {
      "httpUrl": "${url}"
    }
  }
}`,
  },
  {
    k: 'zed',
    name: 'Zed',
    sub: 'Agent Panel',
    color: '#084CCF',
    logo: 'zed',
    oauth: true,
    guide: 'https://zed.dev/docs/ai/mcp',
    stepKeys: ['clients.zed.step1', 'clients.zed.step2', 'clients.zed.step3'],
    config: (url) => `// settings.json
{
  "context_servers": {
    "mcpemails": {
      "url": "${url}"
    }
  }
}`,
  },
  {
    k: 'jetbrains',
    name: 'JetBrains',
    sub: 'AI Assistant',
    color: '#000000',
    logo: 'jetbrains',
    oauth: false,
    needsKey: true,
    guide: 'https://www.jetbrains.com/help/ai-assistant/configure-an-mcp-server.html',
    stepKeys: ['clients.jetbrains.step1', 'clients.jetbrains.step2', 'clients.jetbrains.step3'],
  },
  {
    k: 'raycast',
    name: 'Raycast',
    sub: 'AI',
    color: '#FF6363',
    logo: 'raycast',
    oauth: true,
    guide: 'https://manual.raycast.com/ai/model-context-protocol',
    stepKeys: ['clients.raycast.step1', 'clients.raycast.step2', 'clients.raycast.step3'],
  },
  {
    k: 'warp',
    name: 'Warp',
    sub: 'Agents',
    color: '#01A4FF',
    logo: 'warp',
    oauth: true,
    guide: 'https://docs.warp.dev/agent-platform/capabilities/mcp/',
    stepKeys: ['clients.warp.step1', 'clients.warp.step2', 'clients.warp.step3'],
  },
  {
    k: 'api',
    name: 'API / curl',
    sub: 'Bearer token',
    color: '#073551',
    logo: 'curl',
    oauth: false,
    needsKey: true,
    guide: null,
    stepKeys: ['clients.api.step1', 'clients.api.step2'],
    config: (url) => `curl -X POST ${url} \\
  -H "Authorization: Bearer mcpe_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  },
];

/**
 * Per-client connection guide modal. Highlights the live MCP URL (copyable),
 * lists the steps to connect, shows a copyable config snippet when relevant,
 * and links to the client's official guide. For non-OAuth clients it surfaces
 * a shortcut to create an API key.
 */
function ClientGuideModal({ client, mcpUrl, onClose, onGoToKeys }) {
  const t = useTranslations('dashboard');
  const steps = client.stepKeys.map((k) => t(k));
  const config = client.config ? client.config(mcpUrl) : null;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 520 }} role="dialog" aria-modal="true" aria-labelledby="client-guide-title">
        {/* Header */}
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ClientLogo color={client.color} logo={client.logo} size={38} />
              <div>
                <h2 id="client-guide-title" style={{ margin: 0 }}>{t('clients.connectTitle', { name: client.name })}</h2>
                <div className="sub" style={{ marginTop: 2 }}>
                  {client.oauth ? t('clients.subOauth') : t('clients.subBearer')}
                </div>
              </div>
            </div>
            <button onClick={onClose} aria-label={t('clients.close')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 4, flexShrink: 0, lineHeight: 1 }}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="modal-body">
          <CopyField value={mcpUrl} label={t('clients.mcpServerUrl')} onCopy={() => trackProductEvent('mcp_connection_started', { client: client.k === 'api' ? 'curl' : client.k })} />

          <ol style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {steps.map((s, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  background: 'var(--brand-soft)', border: '1px solid rgba(37,71,229,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 700, color: 'var(--brand)',
                }}>{i + 1}</span>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.5, paddingTop: 1 }}>{s}</span>
              </li>
            ))}
          </ol>

          {client.noteKey ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5 }}>
              <Icon name="zap" size={13} color="var(--fg-4)" style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{t(client.noteKey)}</span>
            </div>
          ) : null}

          {config ? <CopyField value={config} label={t('clients.configuration')} multiline onCopy={() => trackProductEvent('mcp_connection_started', { client: client.k === 'api' ? 'curl' : client.k })} /> : null}

          {client.needsKey ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--brand-soft)', border: '1px solid rgba(37,71,229,0.15)', borderRadius: 8 }}>
              <Icon name="key" size={15} color="var(--brand)" />
              <span style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.5 }}>
                {t('clients.needToken')}
              </span>
              <button
                onClick={() => { onGoToKeys?.(); onClose(); }}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--brand)', whiteSpace: 'nowrap' }}
              >
                {t('clients.createKeyLink')}
              </button>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="modal-foot">
          {client.guide ? (
            <a
              href={client.guide}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 14px', height: 34, marginRight: 'auto', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500, color: 'var(--fg-2)', textDecoration: 'none' }}
            >
              {t('clients.officialGuide', { name: client.name })}
            </a>
          ) : null}
          <Btn variant="primary" onClick={onClose}>{t('clients.done')}</Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * Getting-started guide shown on the Overview page until the workspace has
 * connected an inbox AND a client has made its first MCP call. Two steps:
 * connect an inbox, then connect an MCP client (the URL is highlighted and a
 * per-client guide opens on click).
 */
function GettingStartedGuide({ inboxCount, callsThisMonth, mcpUrl, onConnect, onGoToKeys }) {
  const t = useTranslations('dashboard');
  const [activeClient, setActiveClient] = useState(null);

  const step1Done = inboxCount > 0;
  const step2Done = callsThisMonth > 0;
  const allDone   = step1Done && step2Done;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <div>
          <div className="title">{t('guide.title')}</div>
          <div className="sub">
            {allDone
              ? t('guide.subAllDone')
              : t('guide.subSteps')}
          </div>
        </div>
        {allDone && <Badge tone="live" dot="live">{t('guide.ready')}</Badge>}
      </div>

      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Step 1: connect an inbox */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 16px',
          background: step1Done ? 'var(--bg-page)' : 'var(--bg-sunken)',
          borderRadius: 10, border: '1px solid var(--border-1)',
          opacity: step1Done ? 0.65 : 1, transition: 'opacity var(--dur-2) var(--ease-out)',
        }}>
          <StepDot num={1} done={step1Done} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: step1Done ? 'var(--fg-3)' : 'var(--fg-1)' }}>
              {t('guide.step1Title')}
            </div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)', marginTop: 2, lineHeight: 1.5 }}>
              {t('guide.step1Desc')}
            </div>
          </div>
          {!step1Done ? (
            <div style={{ flexShrink: 0 }}>
              <Btn variant="primary" size="sm" icon="plus" onClick={onConnect}>{t('guide.connectInbox')}</Btn>
            </div>
          ) : null}
        </div>

        {/* Step 2: connect an MCP client */}
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 14, padding: '16px',
          background: 'var(--bg-sunken)', borderRadius: 10, border: '1px solid var(--border-1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
            <StepDot num={2} done={step2Done} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)' }}>
                {t('guide.step2Title')}
              </div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)', marginTop: 2, lineHeight: 1.5 }}>
                {t('guide.step2Desc')}
              </div>
            </div>
          </div>

          <CopyField value={mcpUrl} label={t('guide.mcpServerUrl')} />

          <div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, color: 'var(--fg-3)', marginBottom: 8 }}>
              {t('guide.chooseClient')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
              {MCP_CLIENTS.map((c) => (
                <button
                  key={c.k}
                  onClick={() => { trackProductEvent('mcp_connection_started', { client: c.k === 'api' ? 'curl' : c.k }); setActiveClient(c); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    background: 'var(--bg-surface)', border: '1px solid var(--border-1)',
                    borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                    transition: 'border-color var(--dur-1) var(--ease-out)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--brand)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-1)'; }}
                >
                  <ClientLogo color={c.color} logo={c.logo} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--fg-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {activeClient ? (
        <ClientGuideModal
          client={activeClient}
          mcpUrl={mcpUrl}
          onClose={() => setActiveClient(null)}
          onGoToKeys={onGoToKeys}
        />
      ) : null}
    </div>
  );
}

/** Step indicator dot: number, or a mint check when done. */
function StepDot({ num, done }) {
  return (
    <div style={{
      width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
      background: done ? 'var(--live-soft)' : 'var(--brand-soft)',
      border: `1px solid ${done ? 'rgba(31,203,139,0.28)' : 'rgba(37,71,229,0.2)'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 700,
      color: done ? 'var(--mint-600)' : 'var(--brand)',
      transition: 'all var(--dur-2) var(--ease-out)',
    }}>
      {done ? <Icon name="check" size={12} color="var(--mint-600)" /> : num}
    </div>
  );
}

/* ---------------- Overview ---------------- */
export function OverviewPage({ inboxes, activity, stats, usageData, planLimits, plan = 'free', mcpUrl, memberCount = 0, onConnect, onGoToKeys, onGoToMembers }) {
  const t = useTranslations('dashboard');
  const inboxCount = stats?.inboxCount ?? 0;
  // Last 14 days of real per-day call counts, sliced from the 30-day series.
  const last14 = (usageData?.dailyCounts ?? []).slice(-14);
  const apiKeysCount = stats?.apiKeysCount ?? 0;
  const callsToday = stats?.callsToday ?? 0;
  const callsThisMonth = stats?.callsThisMonth ?? 0;

  // Plan daily burst cap: null means unlimited (Enterprise or unknown).
  const dailyCap = planLimits?.maxDailyBurstCalls ?? null;
  const dailyPct = dailyCap != null && dailyCap > 0 ? callsToday / dailyCap : 0;
  // Warn at ≥80%, block at 100%.
  const dailyAtLimit = dailyCap != null && callsToday >= dailyCap;
  const dailyNearLimit = !dailyAtLimit && dailyCap != null && dailyPct >= 0.8;

  // Plan monthly call cap: null means unlimited (Enterprise or unknown).
  const monthlyCap = planLimits?.maxMonthlyToolCalls ?? null;
  const monthlyPct = monthlyCap != null && monthlyCap > 0 ? callsThisMonth / monthlyCap : 0;
  const monthlyAtLimit = monthlyCap != null && callsThisMonth >= monthlyCap;
  const monthlyNearLimit = !monthlyAtLimit && monthlyCap != null && monthlyPct >= 0.8;

  // Seat cap: null means unlimited (Enterprise or unknown).
  const seatCap = planLimits?.maxMembers ?? null;
  const seatPct = seatCap != null && seatCap > 0 ? memberCount / seatCap : 0;
  const seatAtLimit = seatCap != null && memberCount >= seatCap;
  // Warn when only 1 seat remains (or at ≥80% for larger plans).
  const seatNearLimit = !seatAtLimit && seatCap != null && (seatCap <= 5 ? memberCount >= seatCap - 1 : seatPct >= 0.8);

  // Show the getting-started guide until an inbox is connected AND a client has
  // made its first MCP call (callsThisMonth > 0 means a client is wired up).
  const showGuide = inboxCount === 0 || callsThisMonth === 0;

  return (
    <div className="page">
      <PageHeader
        title={t('overview.title')}
        sub={t('overview.sub')}
        action={<Btn variant="primary" icon="plus" onClick={onConnect}>{t('overview.connectInbox')}</Btn>}
      />

      <div className="stat-grid">
        <div className="stat">
          <div className="label">{t('overview.inboxesConnected')}</div>
          <div className="value">{inboxCount.toLocaleString()}</div>
          <div className="delta">{inboxCount === 1 ? t('overview.oneActiveInbox') : t('overview.activeInboxes', { count: inboxCount })}</div>
        </div>
        <div className="stat">
          <div className="label">{t('overview.apiKeys')}</div>
          <div className="value">{apiKeysCount.toLocaleString()}</div>
          <div className="delta">{apiKeysCount === 1 ? t('overview.oneActiveKey') : t('overview.activeKeys', { count: apiKeysCount })}</div>
        </div>
        <div className="stat">
          <div className="label">{t('overview.callsToday')}</div>
          <div className="value" style={dailyAtLimit ? { color: 'var(--red-600, #dc2626)' } : dailyNearLimit ? { color: 'var(--amber-600, #d97706)' } : {}}>
            {callsToday.toLocaleString()}
          </div>
          <div className="delta">
            {dailyCap != null
              ? t('overview.ofDailyLimit', { cap: dailyCap.toLocaleString() })
              : t('overview.callsUtcDay')}
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
          <div className="label">{t('overview.callsThisMonth')}</div>
          <div className="value" style={monthlyAtLimit ? { color: 'var(--red-600, #dc2626)' } : monthlyNearLimit ? { color: 'var(--amber-600, #d97706)' } : {}}>
            {callsThisMonth.toLocaleString()}
          </div>
          <div className="delta">
            {monthlyCap != null
              ? t('overview.ofMonthlyLimit', { cap: monthlyCap.toLocaleString() })
              : t('overview.callsUtcMonth')}
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
        <div
          className="stat"
          style={onGoToMembers ? { cursor: 'pointer' } : undefined}
          onClick={onGoToMembers}
          role={onGoToMembers ? 'button' : undefined}
          tabIndex={onGoToMembers ? 0 : undefined}
          onKeyDown={onGoToMembers ? (e) => { if (e.key === 'Enter') onGoToMembers(); } : undefined}
          title={onGoToMembers ? t('overview.goToMembers') : undefined}
        >
          <div className="label">{t('overview.teamMembers')}</div>
          <div
            className="value"
            style={seatAtLimit ? { color: 'var(--amber-600, #d97706)' } : seatNearLimit ? { color: 'var(--amber-600, #d97706)' } : {}}
          >
            {memberCount.toLocaleString()}
          </div>
          <div className="delta">
            {seatCap != null
              ? (seatCap === 1
                  ? t('overview.ofSeat', { cap: seatCap, remaining: seatCap - memberCount })
                  : t('overview.ofSeats', { cap: seatCap, remaining: seatCap - memberCount }))
              : (memberCount === 1
                  ? t('overview.oneMemberUnlimited')
                  : t('overview.membersUnlimited', { count: memberCount }))}
          </div>
          {/* Mini progress bar for seat usage */}
          {seatCap != null && (
            <div style={{
              marginTop: 6,
              height: 3,
              borderRadius: 2,
              background: 'var(--bg-sunken, #f1f5f9)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, seatPct * 100)}%`,
                background: seatAtLimit
                  ? 'var(--amber-500, #f59e0b)'
                  : seatNearLimit
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
          callsThisMonth={callsThisMonth}
          mcpUrl={mcpUrl}
          onConnect={onConnect}
          onGoToKeys={onGoToKeys}
        />
      ) : (
        <div className="overview-grid" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="card-h">
              <div>
                <div className="title">{t('overview.callsPerDayTitle')}</div>
                <div className="sub">{t('overview.callsPerDaySub')}</div>
              </div>
              <div className="grow"></div>
              <Badge tone="brand">{t('overview.pro')}</Badge>
            </div>
            <div className="card-body">
              <UsageBars dailyCounts={last14} />
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <div>
                <div className="title">{t('overview.recentActivityTitle')}</div>
                <div className="sub">{t('overview.recentActivitySub')}</div>
              </div>
            </div>
            <div>
              {activity.length === 0 ? (
                <div className="empty" style={{ padding: '32px 20px' }}>
                  <div className="ico"><Icon name="activity" size={20} /></div>
                  <h3 style={{ fontSize: 14 }}>{t('overview.noActivityTitle')}</h3>
                  <p style={{ fontSize: 12.5 }}>{t('overview.noActivityDesc')}</p>
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
 * Formats a YYYY-MM-DD date string as "D Mon", e.g. "24 May", "1 Jun".
 * Used for bar chart axis labels and stat card sub-labels.
 */
function formatBarDate(dateStr) {
  if (!dateStr) return '';
  const [, month, day] = dateStr.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day, 10)} ${monthNames[parseInt(month, 10) - 1]}`;
}

/**
 * Compact bar chart used on the Overview page, rendering real daily call counts.
 *
 * Props:
 *   dailyCounts: array of { date: "YYYY-MM-DD", count: number } objects,
 *                oldest first (typically the last 14 days).
 */
function UsageBars({ dailyCounts }) {
  const t = useTranslations('dashboard');
  if (!dailyCounts || dailyCounts.length === 0) {
    return (
      <div style={{
        height: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--font-sans)',
        fontSize: 12.5,
        color: 'var(--fg-3)',
      }}>
        {t('overview.noCallData')}
      </div>
    );
  }

  const total = dailyCounts.length;
  // Guard against a zero max so empty days don't divide by zero.
  const max = Math.max(...dailyCounts.map((d) => d.count), 1);

  // Show a date label on the first bar, then every 3rd bar, plus the last bar.
  const labels = dailyCounts.map((d, i) => {
    if (i === 0 || i % 3 === 2 || i === total - 1) return formatBarDate(d.date);
    return '';
  });

  return (
    <>
      <div className="bars">
        {dailyCounts.map((d, i) => (
          <div key={d.date}
               className={"bar" + (i >= total - 3 ? " hot" : "")}
               style={{ height: (d.count / max * 100) + "%" }}
               title={`${formatBarDate(d.date)} · ${d.count.toLocaleString()} call${d.count !== 1 ? 's' : ''}`}></div>
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
 *   dailyCounts: array of 30 { date: "YYYY-MM-DD", count: number } objects,
 *                 oldest first (index 0 = 29 days ago, index 29 = today).
 */
function UsageChart30({ dailyCounts }) {
  const t = useTranslations('dashboard');
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
        {t('usage.noCallData')}
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
const WORKFLOW_CARDS = [
  { title: 'Morning inbox triage', prompt: 'Run my morning inbox triage. Group unread messages into needs a reply today, FYI / can wait, and likely noise. Do not change anything.', scope: 'Read only' },
  { title: 'Find and brief', prompt: 'Find the answer in my email: [your question]. Cite the sender, subject, and date that support your answer. Do not change anything.', scope: 'Read only' },
  { title: 'Follow-up radar', prompt: 'Find conversations from the last 14 days where I owe someone a reply or they owe me one. Explain the evidence and rank by urgency. Do not change anything.', scope: 'Read only' },
  { title: 'Decision tracker', prompt: 'Find recent emails containing decisions, commitments, owners, or deadlines. Give me a concise action list with evidence. Do not change anything.', scope: 'Read only' },
  { title: 'Prepare reply drafts', prompt: 'Identify emails that need a reply and propose concise draft responses. Show each proposed recipient and summary before creating a draft. Never send.', scope: 'Requires draft access' },
  { title: 'Clean up safely', prompt: 'Propose a safe organization plan for [receipts/newsletters/etc.]. Show selection criteria and affected count first. Do not change anything until I explicitly confirm.', scope: 'Proposal only' },
  { title: 'Review scheduled sends', prompt: 'Review my pending scheduled sends. Highlight anything stale, ambiguous, or unusually broad. Do not create or cancel anything.', scope: 'Scheduled sends' },
];

export function WorkflowsPage({ mcpUrl }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState('');
  const copy = async (title, prompt) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(title);
      toast({ message: 'Workflow prompt copied.', variant: 'success' });
      setTimeout(() => setCopied(''), 1800);
    } catch { toast({ message: 'Could not copy the prompt.', variant: 'error' }); }
  };
  return (
    <main className="page" style={{ maxWidth: 1040 }}>
      <PageHeader title="Workflows" sub="Reliable email routines you can run in any MCP client. Prompts never add permissions; your connection’s scopes still control every action." />
      <div style={{ background: 'var(--brand-soft, #eef4ff)', border: '1px solid var(--border)', borderRadius: 14, padding: 18, marginBottom: 20, color: 'var(--fg-2)', lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--fg-1)' }}>Use them your way.</strong> Copy a routine into your agent today. Clients that support MCP prompts can also discover the starter library directly from {mcpUrl}.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 14 }}>
        {WORKFLOW_CARDS.map((card) => (
          <article key={card.title} style={{ border: '1px solid var(--border)', borderRadius: 14, padding: 18, background: 'var(--bg-1)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><h2 style={{ margin: 0, fontSize: 16, color: 'var(--fg-1)' }}>{card.title}</h2><span style={{ fontSize: 12, color: 'var(--fg-3)' }}>{card.scope}</span></div>
            <p style={{ margin: 0, color: 'var(--fg-2)', fontSize: 13, lineHeight: 1.55 }}>{card.prompt}</p>
            <Btn onClick={() => copy(card.title, card.prompt)} icon={copied === card.title ? 'check' : 'copy'} style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>{copied === card.title ? 'Copied' : 'Copy prompt'}</Btn>
          </article>
        ))}
      </div>
      <BulkRunsPanel />
    </main>
  );
}

export function InboxesPage({ inboxes, planLimits, onConnect, onRemove, onReconnect, onCheck, onSaveSignature }) {
  const t = useTranslations('dashboard');
  // Count errored inboxes to conditionally show a page-level warning banner.
  const erroredCount = inboxes.filter(ib => ib.status === "error").length;

  // Determine if the workspace is at its inbox cap.
  const maxInboxes = planLimits?.maxInboxes ?? null; // null = unlimited
  const atInboxLimit = maxInboxes !== null && inboxes.length >= maxInboxes;
  // inbox object pending disconnect confirmation, or null
  const [confirmInbox, setConfirmInbox] = useState(null);
  // true while the DELETE API call is in flight
  const [disconnecting, setDisconnecting] = useState(false);
  // id of the inbox whose connection check is currently in flight, or null
  const [checkingId, setCheckingId] = useState(null);
  // inbox whose detail modal is open, or null
  const [detailInbox, setDetailInbox] = useState(null);

  // Keep the open detail modal in sync with refreshed inbox data (e.g. after a
  // connection check updates status) instead of showing a stale snapshot.
  const detailInboxLive = detailInbox
    ? (inboxes.find(ib => ib.id === detailInbox.id) ?? detailInbox)
    : null;

  const handleCheck = async (inbox) => {
    if (checkingId) return;
    setCheckingId(inbox.id);
    try {
      await onCheck(inbox);
    } finally {
      setCheckingId(null);
    }
  };

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

  const connectAction = (
    <Btn variant="primary" icon="plus" onClick={onConnect}>{t('inboxes.connectInbox')}</Btn>
  );

  return (
    <div className="page">
      <PageHeader
        title={t('inboxes.title')}
        sub={
          maxInboxes !== null
            ? (maxInboxes === 1
                ? t('inboxes.subWithCountSingular', { count: inboxes.length, max: maxInboxes })
                : t('inboxes.subWithCount', { count: inboxes.length, max: maxInboxes }))
            : t('inboxes.sub')
        }
        action={connectAction}
      />

      {/* Plan usage indicator: shown when not at limit but limit exists */}
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
          <span>{maxInboxes === 1 ? t('inboxes.usedSingular', { count: inboxes.length, max: maxInboxes }) : t('inboxes.usedPlural', { count: inboxes.length, max: maxInboxes })}</span>
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
              ? t('inboxes.errorBannerOne')
              : t('inboxes.errorBannerMany', { count: erroredCount })}
          </span>
        </div>
      )}

      <div className="card">
        {inboxes.length > 0 ? (
          <>
          <div className="tbl-wrap inbox-table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('inboxes.colLabel')}</th>
                <th>{t('inboxes.colAddress')}</th>
                <th>{t('inboxes.colProvider')}</th>
                <th>{t('inboxes.colStatus')}</th>
                <th>{t('inboxes.colCalls')}</th>
                <th className="right">{""}</th>
              </tr>
            </thead>
            <tbody>
              {inboxes.map(ib => (
                <tr
                  key={ib.id}
                  onClick={() => setDetailInbox(ib)}
                  style={{ cursor: 'pointer' }}
                  tabIndex={0}
                  role="button"
                  aria-label={t('inboxes.detail.openAria', { label: ib.label })}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailInbox(ib); } }}
                >
                  <td><strong style={{ fontWeight: 600 }}>{ib.label}</strong></td>
                  <td className="mono">{ib.address}</td>
                  <td>
                    <span style={{ display:"inline-flex", alignItems:"center", gap:8 }}>
                      <ProviderLogo kind={ib.provider} size={18} />
                      <span style={{ color:"var(--fg-2)" }}>{PROVIDER_LABELS[ib.provider] ?? ib.provider}</span>
                    </span>
                  </td>
                  <td>
                    {ib.status === "active"  ? <Badge tone="live"    dot="live">{t('inboxes.statusConnected')}</Badge>  : null}
                    {ib.status === "pending" ? <Badge tone="neutral">{t('inboxes.statusPending')}</Badge>               : null}
                    {ib.status === "error"   ? (
                      <div>
                        <Badge tone="red" dot="red">{t('inboxes.statusError')}</Badge>
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
                    {ib.status === "revoked" ? <Badge tone="amber"   dot="amber">{t('inboxes.statusExpired')}</Badge>   : null}
                  </td>
                  <td className="mono">{ib.calls.toLocaleString()}</td>
                  <td className="right" onClick={e => e.stopPropagation()}>
                    {ib.status === "error" ? (
                      <Btn
                        variant="secondary"
                        size="sm"
                        icon="refresh"
                        onClick={() => onReconnect(ib)}
                      >
                        {t('inboxes.reconnect')}
                      </Btn>
                    ) : (
                      <Btn
                        variant="ghost"
                        size="sm"
                        icon="refresh"
                        className={checkingId === ib.id ? "is-checking" : ""}
                        disabled={checkingId === ib.id}
                        aria-label={t('inboxes.checkConnection')}
                        title={t('inboxes.checkConnection')}
                        onClick={() => handleCheck(ib)}
                      >
                        {""}
                      </Btn>
                    )}
                    <Btn
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      aria-label={t('inboxes.disconnectInbox')}
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
          <div className="inbox-list-mobile">
            {inboxes.map(ib => {
              const isError = ib.status === 'error';
              const status = ib.status === 'active' ? <Badge tone="live" dot="live">{t('inboxes.statusConnected')}</Badge>
                : ib.status === 'pending' ? <Badge tone="neutral">{t('inboxes.statusPending')}</Badge>
                : isError ? <Badge tone="red" dot="red">{t('inboxes.statusError')}</Badge>
                : ib.status === 'revoked' ? <Badge tone="amber" dot="amber">{t('inboxes.statusExpired')}</Badge>
                : <Badge tone="neutral">{ib.status}</Badge>;
              return (
                <article
                  className="inbox-mobile-card"
                  key={ib.id}
                  onClick={() => setDetailInbox(ib)}
                  tabIndex={0}
                  role="button"
                  aria-label={t('inboxes.detail.openAria', { label: ib.label })}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailInbox(ib); } }}
                >
                  <div className="inbox-mobile-card-top">
                    <div className="inbox-mobile-identity">
                      <strong>{ib.label}</strong>
                      <span className="mono">{ib.address}</span>
                    </div>
                    {status}
                  </div>
                  <div className="inbox-mobile-meta">
                    <span><ProviderLogo kind={ib.provider} size={16} /> {PROVIDER_LABELS[ib.provider] ?? ib.provider}</span>
                    <span>{ib.calls.toLocaleString()} calls</span>
                  </div>
                  {isError && ib.lastError ? <p className="inbox-mobile-error">{ib.lastError}</p> : null}
                  <div className="inbox-mobile-actions" onClick={e => e.stopPropagation()}>
                    <Btn variant="secondary" size="sm" onClick={() => setDetailInbox(ib)}>View details</Btn>
                    {isError ? (
                      <Btn variant="secondary" size="sm" icon="refresh" onClick={() => onReconnect(ib)}>{t('inboxes.reconnect')}</Btn>
                    ) : (
                      <Btn variant="ghost" size="sm" icon="refresh" className={checkingId === ib.id ? 'is-checking' : ''} disabled={checkingId === ib.id} onClick={() => handleCheck(ib)}>{t('inboxes.checkConnection')}</Btn>
                    )}
                    <Btn variant="ghost" size="sm" icon="trash" aria-label={t('inboxes.disconnectInbox')} onClick={() => handleDisconnectRequest(ib)}>{t('inboxes.detail.disconnect')}</Btn>
                  </div>
                </article>
              );
            })}
          </div>
          </>
        ) : (
          <div className="empty">
            <div className="ico"><Icon name="inbox" size={20} /></div>
            <h3>{t('inboxes.emptyTitle')}</h3>
            <p>{t('inboxes.emptyDesc')}</p>
            <div style={{ marginTop: 8 }}>
              <Btn variant="primary" icon="plus" onClick={onConnect}>{t('inboxes.connectInbox')}</Btn>
            </div>
          </div>
        )}
      </div>

      {/* Inbox detail / diagnostics modal */}
      {detailInboxLive && (
        <InboxDetailModal
          inbox={detailInboxLive}
          checking={checkingId === detailInboxLive.id}
          onClose={() => setDetailInbox(null)}
          onReconnect={(ib) => { setDetailInbox(null); onReconnect(ib); }}
          onCheck={(ib) => handleCheck(ib)}
          onDisconnect={(ib) => { setDetailInbox(null); handleDisconnectRequest(ib); }}
          onSaveSignature={onSaveSignature}
        />
      )}

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
  const t = useTranslations('dashboard');
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
                {t('inboxes.disconnectDialog.title')}
              </h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {t('inboxes.disconnectDialog.sub')}
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={disconnecting}
              aria-label={t('inboxes.disconnectDialog.cancel')}
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
            {t('inboxes.disconnectDialog.body')}
          </p>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onCancel} disabled={disconnecting}>
              {t('inboxes.disconnectDialog.cancel')}
            </Btn>
            <Btn variant="danger" icon="trash" onClick={onConfirm} disabled={disconnecting}>
              {disconnecting ? t('inboxes.disconnectDialog.disconnecting') : t('inboxes.disconnectDialog.disconnect')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * InboxDetailModal: a per-inbox diagnostic view.
 *
 * Surfaces the information needed to diagnose a broken connection without
 * digging through the audit log — authentication method, connection status,
 * when it was connected, the last successful MCP call, and the most recent
 * error — plus the actions to fix it (reconnect / check / disconnect).
 */
/**
 * Per-inbox signature editor (Phase 3). Edits the plain-text signature, the
 * enabled toggle, and the reply-mode selector. Saving any field stamps the
 * signature as a manual edit server-side (signature_source = 'manual'), which
 * pins it against the Gmail auto-import.
 *
 * The textarea seeds from signatureText; when only a Gmail-imported HTML value
 * exists (signatureHtml set, signatureText null) we surface an "imported from
 * Gmail" hint and seed the textarea from a light strip of that HTML so the user
 * starts from the imported content. We persist plain text only — the send path
 * derives the HTML half — so saving clears the stored HTML.
 */
function htmlToPlainSeed(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Live preview of the signature, rendered exactly as it will appear in an
 * outgoing email. `html` is already sanitized (it comes from the editor's
 * getHTML() / sanitizeSignatureHtml output), so it is safe for
 * dangerouslySetInnerHTML — we never render raw editor markup. When the editor
 * content exceeds the sanitizer's 100KB cap, `tooBig` is set and we show a
 * graceful fallback instead of the body.
 *
 * The "in a reply" affordance shows the signature above a faux quoted line so
 * the user sees placement. Below it, a note reminds the user that some clients
 * (e.g. Gmail) image-block hosted images by default.
 */
function SignaturePreview({ html, tooBig, t }) {
  return (
    <div className="sig-preview" aria-live="polite">
      <div className="sig-preview-label">{t('inboxes.detail.signature.previewTitle')}</div>
      <div className="sig-preview-surface">
        {tooBig ? (
          <div className="sig-preview-empty">
            {t('inboxes.detail.signature.previewTooLarge')}
          </div>
        ) : (
          <>
            <div
              className="sig-preview-body"
              // Safe: `html` is sanitizer output (getHTML()/sanitizeSignatureHtml).
              dangerouslySetInnerHTML={{ __html: html || '' }}
            />
            <div className="sig-preview-quote" aria-hidden>
              {t('inboxes.detail.signature.previewReplyQuote')}
            </div>
          </>
        )}
      </div>
      <div className="sig-preview-note">
        {t('inboxes.detail.signature.imageNote')}
      </div>
    </div>
  );
}

function SignatureEditor({ inbox, onSave, t }) {
  const wasImported = inbox.signatureSource === 'gmail_import';

  const [enabled, setEnabled] = useState(inbox.signatureEnabled ?? true);
  const [replyMode, setReplyMode] = useState(inbox.signatureReplyMode ?? 'first_only');
  const [approvalRequired, setApprovalRequired] = useState(inbox.sendApprovalRequired ?? false);
  const [saving, setSaving] = useState(false);
  const [sizeError, setSizeError] = useState('');
  // Live preview: sanitized HTML rendered exactly as it will appear in mail.
  // `previewTooBig` flips when getHTML()/sanitize throws the >100KB cap so we
  // show a graceful message instead of crashing the panel.
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTooBig, setPreviewTooBig] = useState(false);
  const editorRef = useRef(null);

  // Pull the current editor HTML through the sanitizer and sync preview state.
  // Called on the editor's onChange (every keystroke / image insert) and once
  // after the editor mounts, so the preview always reflects the live content.
  const syncPreview = (sourceHtml) => {
    if (!editorRef.current) return;
    try {
      // HTML-source edits update React state before the imperative editor ref
      // sees the new value. Use the raw value supplied by that mode so its
      // preview stays live, while applying the same sanitizer as every other
      // editor path.
      const html = typeof sourceHtml === 'string'
        ? sanitizeSignatureHtml(sourceHtml)
        : editorRef.current.getHTML(); // already sanitized; may throw >100KB
      setPreviewTooBig(false);
      setPreviewHtml(html);
    } catch {
      setPreviewTooBig(true);
      setPreviewHtml('');
    }
  };

  // Re-seed toggle/reply-mode when switching to a different inbox's modal. The
  // rich editor itself is remounted (via its `key`) so it reloads that inbox's
  // stored signature; we only reset the surrounding controls here. Seed the
  // preview from the stored HTML (sanitized) so it shows the current signature
  // before the first edit — TipTap's onChange only fires on subsequent updates,
  // not the initial content load.
  useEffect(() => {
    setEnabled(inbox.signatureEnabled ?? true);
    setReplyMode(inbox.signatureReplyMode ?? 'first_only');
    setApprovalRequired(inbox.sendApprovalRequired ?? false);
    setSizeError('');
    setPreviewTooBig(false);
    try {
      const seed = (inbox.signatureHtml && inbox.signatureHtml.trim())
        ? sanitizeSignatureHtml(inbox.signatureHtml)
        : '';
      setPreviewHtml(seed);
    } catch {
      setPreviewTooBig(true);
      setPreviewHtml('');
    }
    // TipTap initializes asynchronously and its onChange doesn't fire on the
    // initial content load, so once the editor is ready pull its real HTML
    // (covers text-seeded signatures where no stored HTML exists).
    const timer = setTimeout(syncPreview, 0);
    return () => clearTimeout(timer);
  }, [inbox.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (saving) return;
    setSizeError('');

    let html = '';
    let text = '';
    try {
      // getHTML() returns already-sanitized HTML and re-throws the >100KB cap.
      html = editorRef.current ? editorRef.current.getHTML() : '';
      text = editorRef.current ? editorRef.current.getText() : '';
    } catch {
      setSizeError(t('inboxes.detail.signature.tooLarge'));
      return;
    }

    setSaving(true);
    try {
      await onSave(inbox.id, {
        signature_html: html,
        signature_text: text,
        signature_enabled: enabled,
        signature_reply_mode: replyMode,
        send_approval_required: approvalRequired,
      });
    } catch {
      // App.jsx already showed an error toast; keep the form as-is for retry.
    } finally {
      setSaving(false);
    }
  };

  const label = { fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)' };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600, color: 'var(--fg-1)' }}>
          {t('inboxes.detail.signature.title')}
        </h3>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', ...label }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={() => setEnabled(v => !v)}
            disabled={saving}
            style={{ accentColor: 'var(--brand)' }}
          />
          {t('inboxes.detail.signature.enabled')}
        </label>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 16, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
        <input type="checkbox" checked={approvalRequired} onChange={() => setApprovalRequired(v => !v)} disabled={saving} style={{ accentColor: 'var(--brand)', marginTop: 2 }} />
        <span><strong style={{ color: 'var(--fg-1)' }}>Require approval before sending</strong><br />Messages sent by an MCP client wait for a workspace approver. Disabled by default.</span>
      </label>

      {wasImported && (
        <div style={{ ...label, marginBottom: 8, color: 'var(--fg-2)' }}>
          {t('inboxes.detail.signature.importedHint')}
        </div>
      )}

      <div style={{ opacity: enabled ? 1 : 0.6, pointerEvents: enabled ? 'auto' : 'none' }}>
        <SignatureRichEditor
          key={inbox.id}
          ref={editorRef}
          inboxId={inbox.id}
          initialHtml={inbox.signatureHtml || ''}
          initialText={
            inbox.signatureText ?? (wasImported ? htmlToPlainSeed(inbox.signatureHtml) : '')
          }
          disabled={saving || !enabled}
          onChange={syncPreview}
        />

        <SignaturePreview
          html={previewHtml}
          tooBig={previewTooBig}
          t={t}
        />
      </div>

      {sizeError && (
        <div style={{ ...label, marginTop: 8, color: 'var(--red-500)' }} role="alert">
          {sizeError}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
        <span style={label}>{t('inboxes.detail.signature.replyModeLabel')}</span>
        <select
          className="input"
          value={replyMode}
          onChange={e => setReplyMode(e.target.value)}
          disabled={saving}
          style={{ height: 32, padding: '0 8px', flex: '0 0 auto', width: 'auto' }}
        >
          <option value="always">{t('inboxes.detail.signature.replyModeAlways')}</option>
          <option value="first_only">{t('inboxes.detail.signature.replyModeFirstOnly')}</option>
          <option value="never">{t('inboxes.detail.signature.replyModeNever')}</option>
        </select>
        <div style={{ flex: 1 }} />
        <Btn
          variant="primary"
          size="sm"
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? t('inboxes.detail.signature.saving') : t('inboxes.detail.signature.save')}
        </Btn>
      </div>
    </div>
  );
}

function InboxDetailModal({ inbox, checking, onClose, onReconnect, onCheck, onDisconnect, onSaveSignature }) {
  const t = useTranslations('dashboard');
  if (!inbox) return null;

  // OAuth providers authenticate with a token; IMAP/Fastmail use an app
  // password (surfaced by hasImap). This is what "OAuth token status" maps to.
  const usesOauth = !inbox.hasImap;
  const compatibility = compatibilityForInbox(inbox.provider);

  const statusLabel =
    inbox.status === 'active'  ? t('inboxes.statusConnected') :
    inbox.status === 'pending' ? t('inboxes.statusPending')   :
    inbox.status === 'error'   ? t('inboxes.statusError')     :
    inbox.status === 'revoked' ? t('inboxes.statusExpired')   :
    inbox.status;

  const statusBadge =
    inbox.status === 'active'  ? <Badge tone="live"    dot="live">{statusLabel}</Badge> :
    inbox.status === 'pending' ? <Badge tone="neutral">{statusLabel}</Badge> :
    inbox.status === 'error'   ? <Badge tone="red"     dot="red">{statusLabel}</Badge> :
    inbox.status === 'revoked' ? <Badge tone="amber"   dot="amber">{statusLabel}</Badge> :
    <Badge tone="neutral">{statusLabel}</Badge>;

  const Row = ({ label, children }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--border-1)' }}>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-3)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--fg-1)', textAlign: 'right' }}>{children}</span>
    </div>
  );

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 480 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-detail-title"
      >
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <ProviderLogo kind={inbox.provider} size={24} />
              <div style={{ minWidth: 0 }}>
                <h2 id="inbox-detail-title" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inbox.label}</h2>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)', marginTop: 2 }}>{inbox.address}</div>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label={t('inboxes.detail.close')}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg-3)', padding: 4, flexShrink: 0, lineHeight: 1 }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body inbox-detail-body">
          <div className="inbox-detail-summary">
            <Row label={t('inboxes.detail.connectionStatus')}>{statusBadge}</Row>
            <Row label={t('inboxes.colProvider')}>{PROVIDER_LABELS[inbox.provider] ?? inbox.provider}</Row>
            <Row label={t('inboxes.detail.authMethod')}>
              {usesOauth ? t('inboxes.detail.authOauth') : t('inboxes.detail.authAppPassword')}
            </Row>
            <Row label={t('inboxes.detail.connectedOn')}>{formatDate(inbox.createdAt)}</Row>
            <Row label={t('inboxes.detail.lastCall')}>
              {inbox.lastCallAt ? formatLastUsed(inbox.lastCallAt, t) : t('inboxes.detail.lastCallNone')}
            </Row>
          </div>

          {/* Surface the most recent error prominently so a broken connection
              is self-explanatory. */}
          {inbox.status === 'error' && inbox.lastError && (
            <div style={{
              padding: '10px 12px',
              marginBottom: 16,
              background: 'var(--red-100)',
              border: '1px solid rgba(229,72,77,0.25)',
              borderRadius: 8,
              fontFamily: 'var(--font-sans)',
              fontSize: 12.5,
              color: 'var(--red-700)',
              lineHeight: 1.5,
            }}>
              {inbox.lastError}
            </div>
          )}

          <div style={{
            padding: '12px',
            marginBottom: 16,
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            background: 'var(--bg-sunken)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 7 }}>
              <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
                Compatibility profile
              </span>
              <Badge tone={compatibility.tone}>{compatibility.status}</Badge>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-3)', marginBottom: 7 }}>
              {compatibility.profile} · connector semantics
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.55 }}>
              {compatibility.notes.map(note => <li key={note}>{note}</li>)}
            </ul>
          </div>

          {onSaveSignature && inbox.status !== 'pending' && (
            <details className="inbox-sending-details">
              <summary>
                <span>Signature &amp; sending</span>
                <span>{inbox.sendApprovalRequired ? 'Approval required' : 'Approval optional'}</span>
              </summary>
              <p>Set the signature and decide whether MCP-sent messages must wait for a workspace approver.</p>
              <SignatureEditor inbox={inbox} onSave={onSaveSignature} t={t} />
            </details>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Btn variant="ghost" icon="trash" onClick={() => onDisconnect(inbox)}>
              {t('inboxes.detail.disconnect')}
            </Btn>
            <Btn
              variant="secondary"
              icon="refresh"
              disabled={checking}
              onClick={() => onCheck(inbox)}
            >
              {t('inboxes.checkConnection')}
            </Btn>
            <Btn variant="primary" icon="refresh" onClick={() => onReconnect(inbox)}>
              {t('inboxes.reconnect')}
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
 * Returns "–" for null/undefined values (e.g. last_used_at before first use).
 */
function formatDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '–';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Formats last_used_at as a relative time when recent, falling back to
 * absolute date for older entries. Returns "Never" when null.
 */
function formatLastUsed(iso, t) {
  if (!iso) return t('apiKeys.never');
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return t('apiKeys.justNow');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('apiKeys.minutesAgo', { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('apiKeys.hoursAgo', { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return t('apiKeys.yesterday');
  if (diffDay < 30) return t('apiKeys.daysAgo', { n: diffDay });
  return formatDate(iso);
}

/**
 * Builds the masked key string shown in the dashboard.
 *
 * We store only the first 8 hex characters of the key suffix (key_prefix).
 * The full 64-character suffix is never stored after creation. The raw key
 * is shown once at creation time and then discarded.
 *
 * Display format:  mcpe_<key_prefix>••••••••••••••••••••••••••
 */
function maskedKey(keyPrefix) {
  return `mcpe_${keyPrefix}${'•'.repeat(24)}`;
}

/* ── CreateKeyModal ───────────────────────────────────────────────────────── */

// Scope vocabulary must match what the MCP server enforces (each tool gates on
// a requiredScope) and the grantable lists in api-keys/route.ts + the OAuth
// authorize flow. search:email is vestigial (read:email already covers search)
// but kept for parity and backward compatibility.
const SCOPE_OPTIONS = [
  { value: 'read:email',      label: 'read:email',      descKey: 'apiKeys.scopes.readDesc' },
  { value: 'search:email',    label: 'search:email',    descKey: 'apiKeys.scopes.searchDesc' },
  { value: 'send:email',      label: 'send:email',      descKey: 'apiKeys.scopes.sendDesc' },
  { value: 'manage:folders',  label: 'manage:folders',  descKey: 'apiKeys.scopes.foldersDesc' },
  { value: 'delete:email',    label: 'delete:email',    descKey: 'apiKeys.scopes.deleteDesc' },
  { value: 'manage:drafts',   label: 'manage:drafts',   descKey: 'apiKeys.scopes.draftsDesc' },
  { value: 'manage:contacts', label: 'manage:contacts', descKey: 'apiKeys.scopes.contactsDesc' },
  { value: 'schedule:email',  label: 'schedule:email',  descKey: 'apiKeys.scopes.scheduleDesc' },
];

/**
 * Modal for creating a new API key.
 * Collects a name and one or more scopes, then calls onCreate(name, scopes).
 * While the request is in flight, inputs are disabled and the button shows a
 * spinner label. Errors surface inline below the form.
 */
function CreateKeyModal({ onCreate, onCancel, existingNames = [] }) {
  const t = useTranslations('dashboard');
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Inline duplicate-name warning (case-insensitive). The server enforces this
  // with a 409; surfacing it as the user types avoids a wasted round-trip and
  // keeps key names distinguishable in the audit log.
  const trimmedName = name.trim();
  const isDuplicate =
    trimmedName.length > 0 &&
    existingNames.some(n => (n ?? '').trim().toLowerCase() === trimmedName.toLowerCase());

  const toggleScope = (value) => {
    setSelectedScopes(prev =>
      prev.includes(value) ? prev.filter(s => s !== value) : [...prev, value]
    );
  };

  const allScopesSelected = selectedScopes.length === SCOPE_OPTIONS.length;
  const toggleAllScopes = () => {
    setSelectedScopes(allScopesSelected ? [] : SCOPE_OPTIONS.map(o => o.value));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError(t('apiKeys.createModal.errNameRequired'));
      return;
    }
    if (trimmed.length > 128) {
      setError(t('apiKeys.createModal.errNameTooLong'));
      return;
    }
    if (selectedScopes.length === 0) {
      setError(t('apiKeys.createModal.errScopeRequired'));
      return;
    }
    if (isDuplicate) {
      setError(t('apiKeys.createModal.errNameDuplicate'));
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await onCreate(trimmed, selectedScopes);
      // onCreate resolves with key data; parent (KeysPage) handles the reveal modal.
    } catch (err) {
      setError(err?.message ?? t('apiKeys.createModal.errCreateFailed'));
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
              <h2 id="create-key-dialog-title" style={{ margin: 0 }}>{t('apiKeys.createModal.title')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {t('apiKeys.createModal.sub')}
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={submitting}
              aria-label={t('apiKeys.createModal.cancel')}
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
                {t('apiKeys.createModal.keyName')}
              </label>
              <input
                id="key-name"
                className="input"
                type="text"
                placeholder={t('apiKeys.createModal.keyNamePlaceholder')}
                value={name}
                onChange={e => setName(e.target.value)}
                disabled={submitting}
                maxLength={128}
                autoFocus
                aria-invalid={isDuplicate || undefined}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  borderColor: isDuplicate ? 'var(--red-500)' : undefined,
                }}
              />
              {isDuplicate && (
                <div style={{
                  marginTop: 6, fontFamily: 'var(--font-sans)', fontSize: 12,
                  color: 'var(--red-500)',
                }}>
                  {t('apiKeys.createModal.errNameDuplicate')}
                </div>
              )}
            </div>

            {/* Scopes */}
            <div style={{ marginBottom: 20 }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, marginBottom: 8,
              }}>
                <div style={{
                  fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                  color: 'var(--fg-2)',
                }}>
                  {t('apiKeys.createModal.permissions')}
                </div>
                <button
                  type="button"
                  onClick={() => !submitting && toggleAllScopes()}
                  disabled={submitting}
                  style={{
                    background: 'transparent', border: 'none', padding: 0,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500,
                    color: 'var(--brand)', opacity: submitting ? 0.5 : 1,
                  }}
                >
                  {allScopesSelected
                    ? t('apiKeys.createModal.clearAll')
                    : t('apiKeys.createModal.selectAll')}
                </button>
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
                          {t(opt.descKey)}
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
                {t('apiKeys.createModal.cancel')}
              </Btn>
              <Btn variant="primary" icon="key" type="submit" disabled={submitting || isDuplicate}>
                {submitting ? t('apiKeys.createModal.creating') : t('apiKeys.createModal.createKey')}
              </Btn>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── EditConnectionModal ──────────────────────────────────────────────────── */

/**
 * Modal for editing an existing connection's granted access — its scopes and
 * which inboxes it can reach — without the user reconnecting their MCP client.
 *
 * Inbox access has two modes:
 *   - "All inboxes": stored as inboxIds = null. Any inbox connected later is
 *     automatically reachable, so the user never has to re-grant.
 *   - "Specific inboxes": an explicit allowlist; at least one must be selected.
 *
 * On save it calls onSave(apiKey.id, { scopes, inboxIds }). onSave throws on
 * failure so the error can be shown inline; on success the modal closes.
 */
function EditConnectionModal({ apiKey, inboxes, onSave, onClose }) {
  const t = useTranslations('dashboard');
  const [selectedScopes, setSelectedScopes] = useState(apiKey.scopes ?? []);
  // inboxIds === null means "all inboxes". Otherwise it's an explicit allowlist.
  const [allInboxes, setAllInboxes] = useState(apiKey.inboxIds == null);
  const [selectedInboxIds, setSelectedInboxIds] = useState(
    () => (Array.isArray(apiKey.inboxIds) ? apiKey.inboxIds : []),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Close on Escape (parity with the ⌘K palette). The backdrop click already
  // dismisses; this adds keyboard parity. Blocked while a save is in flight.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [submitting, onClose]);

  const toggleScope = (value) => {
    setSelectedScopes(prev =>
      prev.includes(value) ? prev.filter(s => s !== value) : [...prev, value]
    );
  };

  const toggleInbox = (id) => {
    setSelectedInboxIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    if (selectedScopes.length === 0) {
      setError(t('apiKeys.editModal.errScopeRequired'));
      return;
    }
    if (!allInboxes && selectedInboxIds.length === 0) {
      setError(t('apiKeys.editModal.errInboxRequired'));
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await onSave(apiKey.id, {
        scopes: selectedScopes,
        inboxIds: allInboxes ? null : selectedInboxIds,
      });
      onClose();
    } catch (err) {
      setError(err?.message ?? t('apiKeys.editModal.errSaveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="scrim" onClick={submitting ? undefined : onClose}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: 520 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-connection-dialog-title"
      >
        {/* Header */}
        <div className="modal-h">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h2 id="edit-connection-dialog-title" style={{ margin: 0 }}>{t('apiKeys.editModal.title')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {t('apiKeys.editModal.sub', { name: apiKey.name })}
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={submitting}
              aria-label={t('apiKeys.editModal.cancel')}
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

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Scopes */}
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                color: 'var(--fg-2)', marginBottom: 8,
              }}>
                {t('apiKeys.editModal.permissions')}
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
                          {t(opt.descKey)}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Inbox access */}
            <div style={{ marginBottom: 20 }}>
              <div style={{
                fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 500,
                color: 'var(--fg-2)', marginBottom: 8,
              }}>
                {t('apiKeys.editModal.inboxAccess')}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* All inboxes */}
                <label
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '10px 12px',
                    border: `1px solid ${allInboxes ? 'var(--border-focus)' : 'var(--border-1)'}`,
                    borderRadius: 8,
                    background: allInboxes ? 'var(--brand-soft)' : 'var(--bg-surface)',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="inbox-access-mode"
                    checked={allInboxes}
                    onChange={() => !submitting && setAllInboxes(true)}
                    disabled={submitting}
                    style={{ marginTop: 1, accentColor: 'var(--brand)', flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
                      {t('apiKeys.editModal.allInboxes')}
                    </div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: 1 }}>
                      {t('apiKeys.editModal.allInboxesDesc')}
                    </div>
                  </div>
                </label>

                {/* Specific inboxes */}
                <label
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    padding: '10px 12px',
                    border: `1px solid ${!allInboxes ? 'var(--border-focus)' : 'var(--border-1)'}`,
                    borderRadius: 8,
                    background: !allInboxes ? 'var(--brand-soft)' : 'var(--bg-surface)',
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  <input
                    type="radio"
                    name="inbox-access-mode"
                    checked={!allInboxes}
                    onChange={() => !submitting && setAllInboxes(false)}
                    disabled={submitting}
                    style={{ marginTop: 1, accentColor: 'var(--brand)', flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)' }}>
                      {t('apiKeys.editModal.specificInboxes')}
                    </div>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)', marginTop: 1 }}>
                      {t('apiKeys.editModal.specificInboxesDesc')}
                    </div>
                  </div>
                </label>
              </div>

              {/* Inbox checkboxes, shown only in "specific" mode */}
              {!allInboxes && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {inboxes.length === 0 ? (
                    <div style={{
                      padding: '10px 12px', borderRadius: 8,
                      background: 'var(--bg-sunken)', border: '1px solid var(--border-1)',
                      fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)',
                    }}>
                      {t('apiKeys.editModal.noInboxes')}
                    </div>
                  ) : (
                    inboxes.map(ib => {
                      const checked = selectedInboxIds.includes(ib.id);
                      return (
                        <label
                          key={ib.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '9px 12px',
                            border: `1px solid ${checked ? 'var(--brand)' : 'var(--border-1)'}`,
                            background: checked ? 'var(--brand-soft)' : 'var(--bg-surface)',
                            borderRadius: 8,
                            cursor: submitting ? 'not-allowed' : 'pointer',
                            opacity: submitting ? 0.7 : 1,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => !submitting && toggleInbox(ib.id)}
                            disabled={submitting}
                            style={{ accentColor: 'var(--brand)', flexShrink: 0 }}
                          />
                          <ProviderLogo kind={ib.provider} size={18} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{
                              fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600,
                              color: 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {ib.label}
                            </div>
                            <div style={{
                              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-3)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {ib.address}
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
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
              <Btn variant="secondary" onClick={onClose} disabled={submitting}>
                {t('apiKeys.editModal.cancel')}
              </Btn>
              <Btn variant="primary" icon="check" type="submit" disabled={submitting}>
                {submitting ? t('apiKeys.editModal.saving') : t('apiKeys.editModal.save')}
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
 *   rawKey   the full plaintext key string (mcpe_<64 hex chars>)
 *   keyName  human-readable name for context
 *   onDone   called when the user clicks "Done" after acknowledging
 */
function KeyRevealModal({ rawKey, keyName, mcpUrl, scopes, onDone }) {
  const t = useTranslations('dashboard');
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [visible, setVisible] = useState(false);

  // Activation funnel: an API key was just created and shown. This is the
  // step immediately before "connect it in Claude", so it pinpoints where
  // users drop between having a key and connecting an inbox.
  useEffect(() => {
    trackProductEvent('api_key_revealed', { scope_profile: scopeProfile(scopes) });
  }, [scopes]);

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
              {t('apiKeys.revealModal.title')}
            </h2>
            <div className="sub" style={{ marginTop: 4 }}>
              {t('apiKeys.revealModal.sub')}
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
              {t('apiKeys.revealModal.createdJustNow')}
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
              title={visible ? t('copy.hideKey') : t('copy.showKey')}
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
              title={t('copy.copyKey')}
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

          {/* Keep credentials in the Authorization header, never in a URL. */}
          {mcpUrl ? (
            <div style={{ marginBottom: 16 }}>
              <CopyField
                value={JSON.stringify({
                  url: mcpUrl,
                  headers: { Authorization: `Bearer ${rawKey}` },
                }, null, 2)}
                label={t('apiKeys.revealModal.urlLabel')}
                multiline
              />
            </div>
          ) : null}

          {/* Next-step payoff: the moment of highest intent. Tell the user
              exactly how to connect in Claude and what to ask first, so the key
              they just created turns into a real tool call instead of a dead
              copy. */}
          <div style={{
            marginBottom: 20, padding: '12px 14px',
            background: 'var(--mint-50)', border: '1px solid rgba(48,164,108,0.22)',
            borderRadius: 10,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
              fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--fg-1)',
            }}>
              <Icon name="zap" size={14} color="var(--mint-600)" />
              {t('apiKeys.revealModal.nextTitle')}
            </div>
            <ol style={{
              margin: '0 0 10px', paddingLeft: 18,
              fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.6,
            }}>
              <li>{t('apiKeys.revealModal.nextStep1')}</li>
              <li>{t('apiKeys.revealModal.nextStep2')}</li>
              <li>
                {t('apiKeys.revealModal.nextStep3')}{' '}
                <span style={{
                  fontStyle: 'italic', color: 'var(--fg-1)',
                }}>&ldquo;{t('apiKeys.revealModal.nextPrompt')}&rdquo;</span>
              </li>
            </ol>
            <a
              href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600,
                color: 'var(--brand)', textDecoration: 'none',
              }}
            >
              {t('apiKeys.revealModal.nextGuide')}
              <Icon name="chevron" size={12} color="var(--brand)" />
            </a>
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
              {t('apiKeys.revealModal.warning')}
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
              {t('apiKeys.revealModal.acknowledge')}
            </span>
          </label>

          {/* Done button: only enabled after acknowledge */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="primary" onClick={onDone} disabled={!acknowledged}>
              {t('apiKeys.revealModal.done')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── RevokeDialog ─────────────────────────────────────────────────────────── */

function RevokeDialog({ apiKey, revoking, onConfirm, onCancel }) {
  const t = useTranslations('dashboard');
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
              <h2 id="revoke-dialog-title" style={{ margin: 0 }}>{t('apiKeys.revokeDialog.title')}</h2>
              <div className="sub" style={{ marginTop: 4 }}>
                {t('apiKeys.revokeDialog.sub')}
              </div>
            </div>
            <button
              onClick={onCancel}
              disabled={revoking}
              aria-label={t('apiKeys.revokeDialog.cancel')}
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
            {t('apiKeys.revokeDialog.body')}
          </p>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={onCancel} disabled={revoking}>{t('apiKeys.revokeDialog.cancel')}</Btn>
            <Btn variant="danger" icon="trash" onClick={onConfirm} disabled={revoking}>
              {revoking ? t('apiKeys.revokeDialog.revoking') : t('apiKeys.revokeDialog.revokeKey')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- API Keys ---------------- */
export function KeysPage({ keys, inboxes = [], mcpUrl, onCreate, onKeyCreated, onRevoke, onUpdate }) {
  const t = useTranslations('dashboard');
  const [copiedId, setCopiedId] = useState(null);
  // The key object pending revoke confirmation, or null.
  const [confirmKey, setConfirmKey] = useState(null);
  // The key object currently being edited (scopes + inbox access), or null.
  const [editKey, setEditKey] = useState(null);
  // True while the revoke API call is in flight.
  const [revoking, setRevoking] = useState(false);
  // True when the create-key modal is open.
  const [createOpen, setCreateOpen] = useState(false);
  // True while the API key creation call is in flight.
  const [creating, setCreating] = useState(false);
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
    setCreating(true);
    try {
      const data = await onCreate(name, scopes);
      // data includes: id, name, keyPrefix, scopes, createdAt, lastUsedAt, expiresAt, rawKey
      setCreateOpen(false);
      setRevealData(data);
    } finally {
      setCreating(false);
    }
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
        title={t('apiKeys.title')}
        sub={t('apiKeys.sub')}
        action={<Btn variant="primary" icon={creating ? 'refresh' : 'plus'} onClick={() => setCreateOpen(true)} disabled={creating}>{creating ? t('apiKeys.creating') : t('apiKeys.newKey')}</Btn>}
      />

      <div className="card">
        {keys.length > 0 ? (
          <div className="tbl-wrap">
          <table className="tbl tbl-api-keys">
            <thead>
              <tr>
                <th>{t('apiKeys.colName')}</th>
                <th>{t('apiKeys.colKey')}</th>
                <th>{t('apiKeys.colScopes')}</th>
                <th>{t('apiKeys.colAccess')}</th>
                <th>{t('apiKeys.colCreated')}</th>
                <th>{t('apiKeys.colLastUsed')}</th>
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
                        title={t('apiKeys.copyPrefix')}
                      >{""}</Btn>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {k.scopes.length === 0
                        ? <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: "var(--fg-3)" }}>{t('apiKeys.noScopes')}</span>
                        : k.scopes.map(s => <Badge key={s} tone="neutral">{s}</Badge>)
                      }
                    </div>
                  </td>
                  <td>
                    {k.inboxIds == null
                      ? <Badge tone="live">{t('apiKeys.accessAll')}</Badge>
                      : <Badge tone="neutral">{t('apiKeys.accessCount', { count: k.inboxIds.length })}</Badge>
                    }
                  </td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--fg-2)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
                    {formatDate(k.createdAt)}
                  </td>
                  <td style={{ whiteSpace: "nowrap", color: k.lastUsedAt ? "var(--fg-2)" : "var(--fg-3)", fontFamily: "var(--font-sans)", fontSize: 13 }}>
                    {formatLastUsed(k.lastUsedAt, t)}
                  </td>
                  <td className="right">
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      {onUpdate && (
                        <Btn variant="secondary" size="sm" icon="settings" onClick={() => setEditKey(k)}>{t('apiKeys.editAccess')}</Btn>
                      )}
                      <Btn variant="danger" size="sm" onClick={() => handleRevokeRequest(k)}>{t('apiKeys.revoke')}</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="empty">
            <div className="ico"><Icon name="key" size={20} /></div>
            <h3>{t('apiKeys.emptyTitle')}</h3>
            <p>{t('apiKeys.emptyDesc')}</p>
            <div style={{ marginTop: 8 }}>
              <Btn variant="primary" icon="plus" onClick={() => setCreateOpen(true)} disabled={creating}>{t('apiKeys.newKey')}</Btn>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <div>
            <div className="title">{t('apiKeys.connectUrlTitle')}</div>
            <div className="sub">{t.rich('apiKeys.connectUrlSub', RICH)}</div>
          </div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <CopyField
            value={JSON.stringify({
              url: mcpUrl,
              headers: { Authorization: 'Bearer YOUR_API_KEY' },
            }, null, 2)}
            label={t('apiKeys.mcpServerUrl')}
            multiline
          />
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-3)', lineHeight: 1.6 }}>
            {t.rich('apiKeys.urlWarning', RICH)}
          </div>
          <CopyField
            value={`curl -X POST ${mcpUrl} \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}
            label={t('apiKeys.authHeaderLabel')}
            multiline
          />
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
          existingNames={keys.map(k => k.name)}
        />
      )}

      {revealData && (
        <KeyRevealModal
          rawKey={revealData.rawKey}
          keyName={revealData.name}
          scopes={revealData.scopes ?? []}
          mcpUrl={mcpUrl}
          onDone={handleRevealDone}
        />
      )}

      {editKey && (
        <EditConnectionModal
          apiKey={editKey}
          inboxes={inboxes}
          onSave={onUpdate}
          onClose={() => setEditKey(null)}
        />
      )}
    </div>
  );
}

/* ---------------- Workflows ---------------- */

// Kept separate from the customer-facing workflow library above. Bulk-run
// controls need their own route/API wiring before they can replace it.
function BulkRunsPanel() {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(null);

  const load = async () => {
    try {
      const response = await fetch('/api/workflows/runs', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to load runs.');
      setRuns(payload.runs || []); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load runs.'); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, []);

  const cancel = async (id) => {
    setCancelling(id);
    try {
      const response = await fetch('/api/workflows/runs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not request cancellation.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not request cancellation.'); }
    finally { setCancelling(null); }
  };

  return <section style={{ marginTop: 28 }}>
    <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Large-work controls</h2>
    <p style={{ color: 'var(--fg-2)', margin: '0 0 14px' }}>See bulk inbox work as it happens. Stop prevents work that has not started; it does not undo messages already changed.</p>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <div className="card" style={{ overflowX: 'auto' }}>
      {loading ? <p style={{ color: 'var(--fg-3)' }}>Loading runs…</p> : runs.length === 0 ? <div className="empty-state"><Icon name="activity" size={24} /><h3>No large-work runs yet</h3><p>Bulk move and flag actions will appear here while they run.</p></div> :
        <table className="data-table"><thead><tr><th>Action</th><th>Inbox</th><th>Progress</th><th>Status</th><th>Started</th><th /></tr></thead><tbody>{runs.map((run) => {
          const active = run.status === 'running' || run.status === 'cancelling';
          const label = run.operation.replaceAll('_', ' ');
          return <tr key={run.id}><td style={{ textTransform: 'capitalize' }}>{label}</td><td>{run.inbox}</td><td>{run.processed} / {run.total} processed · {run.succeeded} changed{run.failed ? ` · ${run.failed} failed` : ''}</td><td><Badge tone={run.status === 'completed' ? 'live' : run.status === 'cancelled_partial' ? 'warning' : active ? 'neutral' : 'danger'}>{run.status.replaceAll('_', ' ')}</Badge></td><td>{new Date(run.createdAt).toLocaleString()}</td><td className="right">{active && <Btn variant="secondary" size="sm" disabled={run.status === 'cancelling' || cancelling === run.id} onClick={() => cancel(run.id)}>{run.status === 'cancelling' ? 'Stopping…' : 'Stop'}</Btn>}</td></tr>;
        })}</tbody></table>}
    </div>
  </section>;
}

/* ---------------- Usage ---------------- */

/**
 * UsagePage: real data from activity_log, passed as the `usageData` prop.
 *
 * usageData shape:
 *   dailyCounts  Array<{ date: "YYYY-MM-DD", count: number }>, 30 entries oldest-first
 *   totalCalls   number  (sum over the 30-day window)
 *   byTool       Array<{ tool: string, count: number, pct: number }>, sorted desc
 *   byInbox      Array<{ inboxId: string, label: string, address: string, count: number, pct: number }>, sorted desc
 */
export function UsagePage({ usageData, planLimits, onConnect, onGoToKeys }) {
  const t = useTranslations('dashboard');
  const {
    dailyCounts = [],
    totalCalls = 0,
    byTool = [],
    byInbox = [],
  } = usageData ?? {};

  // Plan limits: null means unlimited (Enterprise).
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
        title={t('usage.title')}
        sub={t('usage.sub')}
      />

      {/* Daily quota status card: shown whenever a cap exists */}
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
                ? t('usage.quotaExhausted')
                : dailyNearLimit
                  ? t('usage.quotaApproaching', { pct: Math.round(dailyPct * 100) })
                  : t('usage.dailyQuota')}
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
              {t('usage.usedToday', { used: callsToday.toLocaleString(), cap: dailyCap.toLocaleString() })}
              {dailyAtLimit && t('usage.resetsMidnight')}
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
              {t('usage.upgradePlan')}
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
            <h3>{t('usage.emptyTitle')}</h3>
            <p>
              {t('usage.emptyDesc')}
            </p>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
              {onConnect && (
                <Btn variant="primary" icon="plus" onClick={onConnect}>
                  {t('usage.connectInbox')}
                </Btn>
              )}
              {onGoToKeys && (
                <Btn variant="secondary" icon="key" onClick={onGoToKeys}>
                  {t('usage.createApiKey')}
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
                {t('usage.viewDocs')}
              </a>
            </div>
          </div>
        </div>
      ) : (
        /* ── Normal state ──────────────────────────────────────────────── */
        <>
          {/* Summary stats */}
          <div className="stat-grid usage-stat-grid">
            <div className="stat">
              <div className="label">{t('usage.totalCalls')}</div>
              <div className="value">{totalCalls.toLocaleString()}</div>
              <div className="delta">{t('usage.totalCallsDelta')}</div>
            </div>
            <div className="stat">
              <div className="label">{t('usage.dailyAverage')}</div>
              <div className="value">{avgPerDay.toLocaleString()}</div>
              <div className="delta">{t('usage.dailyAverageDelta')}</div>
            </div>
            <div className="stat">
              <div className="label">{t('usage.busiestDay')}</div>
              <div className="value">{busiestDay.count.toLocaleString()}</div>
              <div className="delta">
                {busiestDay.date ? formatBarDate(busiestDay.date) : '–'}
              </div>
            </div>
          </div>

          {/* 30-day bar chart */}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-h">
              <div>
                <div className="title">{t('usage.callsPerDayTitle')}</div>
                <div className="sub">{t('usage.callsPerDaySub')}</div>
              </div>
            </div>
            <div className="card-body">
              <UsageChart30 dailyCounts={dailyCounts} />
            </div>
          </div>

          {/* Breakdown by tool */}
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-h">
              <div className="title">{t('usage.callsByToolTitle')}</div>
            </div>
            {byTool.length === 0 ? (
              <div className="empty" style={{ padding: '28px 20px' }}>
                <div className="ico"><Icon name="zap" size={18} /></div>
                <h3 style={{ fontSize: 14 }}>{t('usage.noToolCallsTitle')}</h3>
                <p style={{ fontSize: 12.5 }}>{t('usage.noToolCallsDesc')}</p>
              </div>
            ) : (
              <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('usage.colTool')}</th>
                    <th>{t('usage.colCalls')}</th>
                    <th>{t('usage.colShare')}</th>
                    <th style={{ width: 200 }}>{''}</th>
                  </tr>
                </thead>
                <tbody>
                  {byTool.map((row) => (
                    <tr key={row.tool}>
                      <td>
                        <code
                          className="mono"
                          style={{ color: 'var(--cobalt-700)', fontWeight: 500 }}
                        >
                          {row.tool}
                        </code>
                      </td>
                      <td className="mono">{row.count.toLocaleString()}</td>
                      <td className="mono">{row.pct}%</td>
                      <td>
                        <div style={{
                          height: 6,
                          borderRadius: 3,
                          background: 'var(--ink-100)',
                          overflow: 'hidden',
                        }}>
                          <div style={{
                            width: row.pct + '%',
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

          {/* Breakdown by inbox: only shown when multiple inboxes have activity */}
          {byInbox.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-h">
                <div className="title">{t('usage.callsByInboxTitle')}</div>
              </div>
              <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('usage.colInbox')}</th>
                    <th>{t('usage.colAddress')}</th>
                    <th>{t('usage.colCalls')}</th>
                    <th>{t('usage.colShare')}</th>
                    <th style={{ width: 200 }}>{''}</th>
                  </tr>
                </thead>
                <tbody>
                  {byInbox.map((ib) => (
                    <tr key={ib.inboxId} style={ib.archived ? { opacity: 0.6 } : undefined}>
                      <td>
                        <strong style={{ fontWeight: 600, color: ib.archived ? 'var(--fg-3)' : undefined }}>
                          {ib.label}
                        </strong>
                        {ib.archived && (
                          <span style={{ marginLeft: 8 }}>
                            <Badge tone="neutral">{t('usage.inboxArchived')}</Badge>
                          </span>
                        )}
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
 * ProfileSection: display name update form + read-only email display.
 *
 * Calls PATCH /api/user/profile on submit and surfaces success / error
 * feedback inline below the form using the same inline feedback pattern
 * used elsewhere in the dashboard.
 *
 * Props:
 *   displayName  current display name from the users table (may be empty string)
 *   email        read-only email address from Supabase Auth (never editable here)
 */
function ProfileSection({ displayName: initialDisplayName, email }) {
  const t = useTranslations('dashboard');
  const [name, setName] = useState(initialDisplayName ?? '');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // Email change is its own self-contained flow: it does not write the users
  // table directly — POST /api/user/email starts a confirmation flow and the
  // address only changes once the user clicks the link sent to the new inbox.
  const [emailValue, setEmailValue] = useState(email ?? '');
  const [emailSaving, setEmailSaving] = useState(false);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normalizedEmail = emailValue.trim().toLowerCase();
  const emailDirty = normalizedEmail !== (email ?? '').toLowerCase();
  const emailValid = EMAIL_RE.test(normalizedEmail) && normalizedEmail.length <= 254;

  const handleEmailSubmit = async () => {
    if (emailSaving || !emailDirty) return;
    if (!emailValid) {
      toast({ message: t('settings.profile.errEmailInvalid'), variant: 'error' });
      return;
    }

    setEmailSaving(true);
    try {
      const res = await fetch('/api/user/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normalizedEmail }),
      });

      if (!res.ok) {
        let message = t('settings.profile.errEmailFailed');
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore */ }
        toast({ message, variant: 'error' });
        return;
      }

      toast({ message: t('settings.profile.emailConfirmSent', { email: normalizedEmail }), variant: 'success' });
    } catch {
      toast({ message: t('settings.profile.networkError'), variant: 'error' });
    } finally {
      setEmailSaving(false);
    }
  };

  // True when there is a pending unsaved change
  const isDirty = name.trim() !== (initialDisplayName ?? '').trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast({ message: t('settings.profile.errEmpty'), variant: 'error' });
      return;
    }
    if (trimmed.length > 100) {
      toast({ message: t('settings.profile.errTooLong'), variant: 'error' });
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
        let message = t('settings.profile.errSaveFailed');
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') message = data.error;
        } catch { /* ignore */ }
        toast({ message, variant: 'error' });
        return;
      }

      toast({ message: t('settings.profile.updated'), variant: 'success' });
    } catch {
      toast({ message: t('settings.profile.networkError'), variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setName(initialDisplayName ?? '');
  };

  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <div className="card-h">
        <div>
          <div className="title">{t('settings.profile.title')}</div>
          <div className="sub">{t('settings.profile.sub')}</div>
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Display name: editable */}
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
              {t('settings.profile.displayName')}
            </label>
            <input
              id="profile-display-name"
              className="input"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={saving}
              maxLength={100}
              placeholder={t('settings.profile.namePlaceholder')}
              style={{ width: '100%', boxSizing: 'border-box' }}
              autoComplete="name"
            />
          </div>

          {/* Email: editable via a confirmation flow */}
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
              {t('settings.profile.email')}
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                id="profile-email"
                className="input"
                type="email"
                value={emailValue}
                onChange={e => setEmailValue(e.target.value)}
                disabled={emailSaving}
                maxLength={254}
                autoComplete="email"
                style={{ flex: 1, minWidth: 0, boxSizing: 'border-box' }}
                aria-describedby="profile-email-hint"
              />
              <Btn
                variant="secondary"
                type="button"
                onClick={handleEmailSubmit}
                disabled={emailSaving || !emailDirty || !emailValid}
              >
                {emailSaving ? t('settings.profile.emailSending') : t('settings.profile.emailChange')}
              </Btn>
            </div>
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
              {t('settings.profile.emailHint')}
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
              {t('settings.profile.cancel')}
            </Btn>
            <Btn
              variant="primary"
              type="submit"
              disabled={saving || !isDirty}
            >
              {saving ? t('settings.profile.saving') : t('settings.profile.saveChanges')}
            </Btn>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * PasswordSection: change-password form.
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
  const t = useTranslations('dashboard');
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

    // Client-side validation: surface immediately inline so the user can
    // fix typos without waiting for a round trip.
    if (!currentPassword) {
      setInlineError(t('settings.password.errCurrentRequired'));
      return;
    }
    if (!newPassword) {
      setInlineError(t('settings.password.errNewRequired'));
      return;
    }
    if (newPassword.length < 8) {
      setInlineError(t('settings.password.errTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setInlineError(t('settings.password.errMismatch'));
      return;
    }
    if (currentPassword === newPassword) {
      setInlineError(t('settings.password.errSame'));
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
        let message = t('settings.password.errUpdateFailed');
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
      toast({ message: t('settings.password.updated'), variant: 'success' });
    } catch {
      toast({ message: t('settings.password.networkError'), variant: 'error' });
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
          <div className="title">{t('settings.password.title')}</div>
          <div className="sub">{t('settings.password.sub')}</div>
        </div>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Current password */}
          <div className="field">
            <label htmlFor="pwd-current" style={labelStyle}>
              {t('settings.password.current')}
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
              {t('settings.password.new')}
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
              {t('settings.password.confirm')}
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
              {saving ? t('settings.password.updating') : t('settings.password.updatePassword')}
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
  const t = useTranslations('dashboard');
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
        let msg = t('settings.deleteAccount.errFailed');
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
      setError(t('settings.deleteAccount.networkError'));
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
              {t('settings.deleteAccount.title')}
            </div>
            <div className="sub">
              {t('settings.deleteAccount.sub')}
            </div>
          </div>
        </div>
        <div
          className="card-body"
          style={{ display: 'flex', justifyContent: 'flex-end' }}
        >
          <Btn variant="danger" onClick={handleOpen}>
            {t('settings.deleteAccount.button')}
          </Btn>
        </div>
      </div>

      {/* Confirmation dialog: rendered as a modal overlay */}
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
                  {t('settings.deleteAccount.dialogTitle')}
                </div>
                <div className="sub" style={{ marginTop: 4 }}>
                  {t('settings.deleteAccount.dialogSub')}
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
                  {t('settings.deleteAccount.typePrefix')}{' '}
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
                  {t('settings.deleteAccount.typeToConfirm')}
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
                  {t('settings.deleteAccount.cancel')}
                </Btn>
                <Btn
                  variant="danger"
                  onClick={handleConfirm}
                  disabled={!emailMatches || deleting}
                >
                  {deleting ? t('settings.deleteAccount.deleting') : t('settings.deleteAccount.button')}
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
 * Plan feature lists and fallback prices. Displayed prices are overridden at
 * render time by live Stripe data (passed in via `stripePrices`); these numeric
 * values are only used when a Stripe price ID isn't configured. Stripe price IDs
 * are resolved server-side by POST /api/stripe/checkout.
 */
const BILLING_PLANS = [
  {
    id: 'solo',
    name: 'Solo',
    monthlyPrice: 12,
    yearlyMonthlyPrice: 10,     // effective monthly cost when billed yearly ($120/yr)
    yearlyAnnualTotal: 120,
    featureKeys: ['billing.plans.soloFeature1', 'billing.plans.soloFeature2', 'billing.plans.soloFeature3', 'billing.plans.soloFeature4'],
    highlighted: false,
  },
  {
    id: 'pro',
    name: 'Team',
    monthlyPrice: 49,
    yearlyMonthlyPrice: 41,     // effective monthly cost when billed yearly ($490/yr)
    yearlyAnnualTotal: 490,
    featureKeys: ['billing.plans.teamFeature1', 'billing.plans.teamFeature2', 'billing.plans.teamFeature3', 'billing.plans.teamFeature4', 'billing.plans.teamFeature5', 'billing.plans.teamFeature6'],
    highlighted: true,
  },
];

/**
 * BillingSection: shows the current plan and upgrade options.
 *
 * For free-plan workspaces it renders Solo and Team upgrade cards.
 * For paid-plan workspaces it shows the active plan and a link to the
 * Stripe customer portal.
 *
 * Props:
 *   currentPlan: 'free' | 'pro' | 'enterprise' from workspaces.plan
 */
function BillingSection({ currentPlan, stripePrices, upgradeIntent }) {
  const t = useTranslations('dashboard');
  const [interval, setInterval] = useState('month');
  const [upgrading, setUpgrading] = useState(null); // planId while loading
  const [openingPortal, setOpeningPortal] = useState(false);
  const automaticUpgradeStarted = useRef(false);
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
            : t('billing.errPortalFailed');
        toast({ message, variant: 'error' });
        return;
      }

      if (typeof data?.url === 'string') {
        window.location.href = data.url;
      } else {
        toast({ message: t('billing.errUnexpected'), variant: 'error' });
      }
    } catch {
      toast({ message: t('billing.networkError'), variant: 'error' });
    } finally {
      setOpeningPortal(false);
    }
  };

  const handleUpgrade = async (planId, checkoutInterval = interval) => {
    if (upgrading) return;
    setUpgrading(planId);
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, interval: checkoutInterval }),
      });

      const data = await res.json();

      if (!res.ok) {
        const message =
          typeof data?.error === 'string'
            ? data.error
            : t('billing.errCheckoutFailed');
        toast({ message, variant: 'error' });
        return;
      }

      if (typeof data?.url === 'string') {
        // Redirect to Stripe Checkout hosted page
        window.location.href = data.url;
      } else {
        toast({ message: t('billing.errCheckoutUnexpected'), variant: 'error' });
      }
    } catch {
      toast({ message: t('billing.networkError'), variant: 'error' });
    } finally {
      setUpgrading(null);
    }
  };

  const isOnPaidPlan = currentPlan === 'solo' || currentPlan === 'pro' || currentPlan === 'enterprise';

  // A paid-plan CTA on the pricing page is a direct request to begin Stripe
  // Checkout. The URL carries only a validated plan and interval; remove it
  // once consumed so refresh/back cannot accidentally initiate it again.
  useEffect(() => {
    if (!upgradeIntent || automaticUpgradeStarted.current) return;
    automaticUpgradeStarted.current = true;
    setInterval(upgradeIntent.interval);
    window.history.replaceState(window.history.state, '', '/dashboard/settings');
    handleUpgrade(upgradeIntent.planId, upgradeIntent.interval);
  // Intent is parsed and validated by DashboardApp. This effect must run once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upgradeIntent]);

  // Display label for the current plan. "free" is translated; paid plan names
  // (Solo / Team / Enterprise) are brand-style names kept as-is (capitalized).
  const planKey = currentPlan ?? 'free';
  const planDisplay = planKey === 'free'
    ? t('billing.free')
    : (planKey === 'pro' ? 'Team' : planKey.charAt(0).toUpperCase() + planKey.slice(1));

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
          <div className="title">{t('billing.title')}</div>
          <div className="sub">{t('billing.sub')}</div>
        </div>
        {/* Current plan badge */}
        <div style={{ marginLeft: 'auto' }}>
          <Badge tone={currentPlan === 'free' ? 'neutral' : 'brand'}>
            {t('billing.planBadge', { plan: planDisplay })}
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
              {t('billing.thisMonthsUsage')}
            </div>

            {/* Monthly calls */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                  {t('billing.mcpCallsThisMonth')}
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
                    ? t('billing.callsRemaining', { remaining: (monthlyCap - (monthlyUsed ?? 0)).toLocaleString(), date: new Date(usage.monthly.resets_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })
                    : t('billing.monthlyExhausted', { date: new Date(usage.monthly.resets_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })}
                </div>
              )}
            </div>

            {/* Daily burst calls */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--fg-2)' }}>
                  {t('billing.callsTodayBurst')}
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
                  {t('billing.resetsMidnight')}
                </div>
              )}
            </div>

          </div>
        )}

        {isOnPaidPlan ? (
          /* Paid plan: show active subscription summary + portal button */
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
                  {t('billing.onPlan', { plan: planDisplay })}
                </div>
                <div style={{
                  fontFamily: 'var(--font-sans)',
                  fontSize: 12.5,
                  color: 'var(--fg-3)',
                  lineHeight: 1.5,
                }}>
                  {t('billing.portalDesc')}
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
                  {openingPortal ? t('billing.openingPortal') : t('billing.manageBilling')}
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
                'billing.portalItem1',
                'billing.portalItem2',
                'billing.portalItem3',
              ].map(itemKey => (
                <div key={itemKey} style={{
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
                    {t(itemKey)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Free plan: show upgrade cards */
          <>
            {/* Interval toggle */}
            <div style={{ display: 'flex', gap: 0, alignSelf: 'flex-start', borderRadius: 8, border: '1px solid var(--border-1)', overflow: 'hidden' }}>
              {[{ value: 'month', label: t('billing.monthly') }, { value: 'year', label: t('billing.annual') }].map(opt => (
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
                // Custom-priced plans (Enterprise) never show a numeric price.
                const isCustom = plan.monthlyPrice === null;

                // Derive live prices from Stripe (cents), falling back to the
                // static plan values when a price ID isn't configured.
                const liveMonthlyCents = stripePrices?.[plan.id]?.monthlyCents;
                const liveYearlyCents = stripePrices?.[plan.id]?.yearlyCents;

                const monthlyPrice =
                  liveMonthlyCents != null && liveMonthlyCents > 0
                    ? liveMonthlyCents / 100
                    : plan.monthlyPrice;
                const yearlyMonthlyPrice =
                  liveYearlyCents != null && liveYearlyCents > 0
                    ? Math.round(liveYearlyCents / 12 / 100)
                    : plan.yearlyMonthlyPrice;
                const yearlyAnnualTotal =
                  liveYearlyCents != null && liveYearlyCents > 0
                    ? liveYearlyCents / 100
                    : plan.yearlyAnnualTotal;

                const price = interval === 'year' ? yearlyMonthlyPrice : monthlyPrice;
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
                          <Badge tone="brand">{t('billing.mostPopular')}</Badge>
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
                          {isCustom ? t('billing.custom') : `$${price}`}
                        </span>
                        {!isCustom && (
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--fg-3)' }}>
                            {t('billing.perMonth')}
                          </span>
                        )}
                      </div>
                      {!isCustom && interval === 'year' && (
                        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--fg-3)', marginTop: 2 }}>
                          {t('billing.billedYearly', { total: yearlyAnnualTotal })}
                        </div>
                      )}
                    </div>

                    {/* Feature list */}
                    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {plan.featureKeys.map(featKey => (
                        <li key={featKey} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <Icon name="check" size={12} color="var(--mint-600)" style={{ flexShrink: 0, marginTop: 2 }} />
                          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12.5, color: 'var(--fg-2)', lineHeight: 1.4 }}>
                            {t(featKey)}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {/* CTA */}
                    {isCustom ? (
                      <a
                        className="btn btn-secondary"
                        href="mailto:sales@mcpemails.com"
                        style={{ marginTop: 'auto', textAlign: 'center', justifyContent: 'center' }}
                      >
                        {t('billing.talkToSales')}
                      </a>
                    ) : (
                      <Btn
                        variant={plan.highlighted ? 'primary' : 'secondary'}
                        onClick={() => handleUpgrade(plan.id)}
                        disabled={isCurrentPlanMatch || isLoading || upgrading !== null}
                        style={{ marginTop: 'auto' }}
                      >
                        {isLoading
                          ? t('billing.redirecting')
                          : isCurrentPlanMatch
                          ? t('billing.currentPlan')
                          : t('billing.getPlan', { plan: plan.name })}
                      </Btn>
                    )}
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
              {t('billing.redirectNote')}
            </p>
            <p style={{ fontSize: 12, color: 'var(--fg-3)', lineHeight: 1.5, marginTop: 4 }}>
              {t('billing.customNote')} <a href="mailto:sales@mcpemails.com" style={{ color: 'var(--brand)', fontWeight: 600 }}>{t('billing.contactUs')}</a>.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * LanguageSection: lets the user switch the app interface language.
 * The choice is persisted to localStorage by AppLocaleProvider.
 */
function LanguageSection() {
  const t = useTranslations('dashboard');
  const { locale, setLocale } = useAppLocale();

  // Each language is shown by its own native name (autonym) so the option is
  // recognizable regardless of the current interface language.
  const LOCALE_LABELS = { en: 'English', nb: 'Norsk', es: 'Español', fr: 'Français', zh: '中文' };
  const options = routing.locales.map((value) => ({ value, label: LOCALE_LABELS[value] || value }));

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
      <div className="card-h"><div className="title">{t('settings.languageHeading')}</div></div>
      <div className="card-body">
        <div className="language-selector">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setLocale(opt.value)}
              aria-pressed={locale === opt.value}
              style={{
                padding: '6px 16px',
                fontFamily: 'var(--font-sans)',
                fontSize: 12.5,
                fontWeight: 500,
                border: 'none',
                cursor: 'pointer',
                background: locale === opt.value ? 'var(--brand)' : 'transparent',
                color: locale === opt.value ? '#fff' : 'var(--fg-2)',
                transition: 'background 120ms, color 120ms',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * WorkspaceSection: controlled rename form for the active workspace.
 *
 * Updates display_name (not slug — slugs are used in MCP endpoint URLs and
 * changing them would break existing client configs). The label says
 * "Workspace name" and the field is pre-filled with the current display_name.
 * On success the parent's onWorkspaceUpdate callback is called so the sidebar
 * and breadcrumb (which read workspace.displayName) reflect the new name.
 */
function WorkspaceSection({ workspace, onWorkspaceUpdate }) {
  const t = useTranslations('dashboard');
  const { toast } = useToast();

  function currentName() {
    return workspace?.displayName ?? workspace?.display_name ?? workspace?.slug ?? '';
  }

  const [name, setName] = useState(() => currentName());
  // Track the last-saved name so isDirty stays correct after a successful save.
  const [savedName, setSavedName] = useState(() => currentName());
  const [saving, setSaving] = useState(false);

  // Re-sync when the active workspace changes (workspace switch or external update).
  useEffect(() => {
    const n = currentName();
    setName(n);
    setSavedName(n);
  }, [workspace?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = name.trim() !== savedName.trim();

  function handleCancel() {
    setName(savedName);
  }

  async function handleSave() {
    if (saving || !isDirty) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ message: 'Workspace name cannot be empty.', variant: 'error' });
      return;
    }
    if (trimmed.length > 60) {
      toast({ message: 'Workspace name must be 60 characters or fewer.', variant: 'error' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ message: data.error ?? 'Failed to update workspace name.', variant: 'error' });
        return;
      }
      // Update saved baseline so isDirty resets correctly.
      setSavedName(trimmed);
      // Propagate the new name up so sidebar + breadcrumb update instantly.
      if (onWorkspaceUpdate) {
        onWorkspaceUpdate({ ...workspace, displayName: trimmed, display_name: trimmed });
      }
      toast({ message: 'Workspace name updated.', variant: 'success' });
    } catch {
      toast({ message: 'Network error. Please try again.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 640, marginTop: 14 }}>
      <div className="card-h">
        <div>
          <div className="title">{t('settings.workspace.title')}</div>
          <div className="sub">
            {t('settings.workspace.sub', { name: currentName() })}
          </div>
        </div>
      </div>
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
            {t('settings.workspace.name')}
          </label>
          <input
            id="settings-workspace-name"
            className="input"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={saving}
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={handleCancel} disabled={saving || !isDirty}>
            {t('settings.workspace.cancel')}
          </Btn>
          <Btn variant="primary" onClick={handleSave} disabled={saving || !isDirty}>
            {saving ? 'Saving…' : t('settings.workspace.saveChanges')}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DeleteWorkspaceSection                                              */
/*                                                                     */
/* Workspace-scoped danger zone. Soft-deletes ONLY the active          */
/* workspace and its data (inboxes, API keys, members, invites),       */
/* leaving the user's account and any other workspaces untouched.      */
/*                                                                     */
/* Visibility/behaviour:                                               */
/*   - Only the workspace OWNER sees this card (admins/members cannot  */
/*     delete a workspace).                                            */
/*   - If this is the user's ONLY workspace, deletion is disabled with */
/*     a note pointing them to "Delete account" — a user must always   */
/*     have at least one workspace.                                    */
/*   - Otherwise: clicking opens a confirm dialog that requires typing */
/*     the workspace name, then DELETE /api/workspaces/[id] and a      */
/*     redirect to /dashboard (the server resolves a new active ws).   */
/* ------------------------------------------------------------------ */
function DeleteWorkspaceSection({ workspace, isOwner, isOnlyWorkspace }) {
  const t = useTranslations('dashboard');
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  const wsName = workspace?.displayName ?? workspace?.display_name ?? workspace?.slug ?? '';

  // Only the owner may delete the workspace.
  if (!isOwner) return null;

  const nameMatches =
    confirmValue.trim().toLowerCase() === wsName.trim().toLowerCase();

  function handleOpen() {
    if (isOnlyWorkspace) return;
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
    if (!nameMatches || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: confirmValue.trim() }),
      });
      if (!res.ok) {
        let msg = t('settings.deleteWorkspace.errFailed');
        try {
          const data = await res.json();
          if (typeof data?.error === 'string') msg = data.error;
        } catch { /* ignore */ }
        setError(msg);
        setDeleting(false);
        return;
      }
      // Workspace gone. Reload the dashboard; the server picks a new active ws.
      window.location.assign('/dashboard');
    } catch {
      setError(t('settings.deleteWorkspace.networkError'));
      setDeleting(false);
    }
  }

  return (
    <>
      {/* Danger zone card (workspace-scoped) */}
      <div
        className="card"
        style={{
          maxWidth: 640,
          marginTop: 14,
          borderColor: 'rgba(229,72,77,0.25)',
        }}
      >
        <div className="card-h" style={{ borderColor: 'rgba(229,72,77,0.25)' }}>
          <div>
            <div className="title" style={{ color: 'var(--red-700)' }}>
              {t('settings.deleteWorkspace.title')}
            </div>
            <div className="sub">
              {isOnlyWorkspace
                ? t('settings.deleteWorkspace.onlyWorkspaceNote')
                : t('settings.deleteWorkspace.sub', { name: wsName })}
            </div>
          </div>
        </div>
        <div
          className="card-body"
          style={{ display: 'flex', justifyContent: 'flex-end' }}
        >
          <Btn variant="danger" onClick={handleOpen} disabled={isOnlyWorkspace}>
            {t('settings.deleteWorkspace.button')}
          </Btn>
        </div>
      </div>

      {/* Confirmation dialog */}
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
                  {t('settings.deleteWorkspace.dialogTitle', { name: wsName })}
                </div>
                <div className="sub" style={{ marginTop: 4 }}>
                  {t('settings.deleteWorkspace.dialogSub')}
                </div>
              </div>
            </div>

            <div
              className="card-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <div>
                <label
                  htmlFor="delete-workspace-confirm"
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--fg-2)',
                    marginBottom: 8,
                  }}
                >
                  {t('settings.deleteWorkspace.typePrefix')}{' '}
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
                    {wsName}
                  </span>{' '}
                  {t('settings.deleteWorkspace.typeToConfirm')}
                </label>
                <input
                  id="delete-workspace-confirm"
                  className="input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmValue}
                  onChange={(e) => {
                    setConfirmValue(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nameMatches) handleConfirm();
                    if (e.key === 'Escape') handleCancel();
                  }}
                  placeholder={wsName}
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

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Btn variant="secondary" onClick={handleCancel} disabled={deleting}>
                  {t('settings.deleteWorkspace.cancel')}
                </Btn>
                <Btn
                  variant="danger"
                  onClick={handleConfirm}
                  disabled={!nameMatches || deleting}
                >
                  {deleting
                    ? t('settings.deleteWorkspace.deleting')
                    : t('settings.deleteWorkspace.button')}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * SettingsSectionLabel: a lightweight scope heading used to group the settings
 * cards into "Account" vs "Workspace" so it's unambiguous which actions affect
 * the whole account and which affect only the current workspace.
 */
function SettingsSectionLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--fg-3, var(--fg-2))',
        margin: '28px 0 2px',
        maxWidth: 640,
      }}
    >
      {children}
    </div>
  );
}

export function SettingsPage({ user, workspace, workspaces = [], userRole, stripePrices, upgradeIntent, onWorkspaceUpdate }) {
  const t = useTranslations('dashboard');

  // The active workspace is owned by the user when either the server-resolved
  // role is "owner" or the workspace's owner flag is set.
  const isOwner = userRole === 'owner' || workspace?.isOwner === true;
  // A user always keeps at least one workspace; deleting the only one is blocked
  // (they delete their account instead).
  const isOnlyWorkspace = (workspaces?.length ?? 0) <= 1;

  return (
    <div className="page">
      <PageHeader title={t('settings.title')} sub={t('settings.sub')} />

      {/* ── Account: settings that affect your whole account ─────────────── */}
      <SettingsSectionLabel>{t('settings.sections.account')}</SettingsSectionLabel>

      {/* Profile section: display name + read-only email */}
      <ProfileSection
        displayName={user?.displayName ?? ''}
        email={user?.email ?? ''}
      />

      {/* Password change section */}
      <PasswordSection />

      {/* Language selector */}
      <LanguageSection />

      {/* Billing section: current plan + upgrade (account-level subscription) */}
      <BillingSection currentPlan={workspace?.plan ?? 'free'} stripePrices={stripePrices} upgradeIntent={upgradeIntent} />

      {/* ── Workspace: settings that affect only the current workspace ───── */}
      <SettingsSectionLabel>{t('settings.sections.workspace')}</SettingsSectionLabel>

      {/* Workspace section: rename the workspace display name */}
      <WorkspaceSection workspace={workspace} onWorkspaceUpdate={onWorkspaceUpdate} />

      {/* Delete THIS workspace only (owner-only) */}
      <DeleteWorkspaceSection
        workspace={workspace}
        isOwner={isOwner}
        isOnlyWorkspace={isOnlyWorkspace}
      />

      {/* ── Danger zone: deletes your entire account ─────────────────────── */}
      <SettingsSectionLabel>{t('settings.sections.dangerZone')}</SettingsSectionLabel>

      {/* Delete account: removes the account and every workspace you own */}
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
function formatSessionAge(iso, t) {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '–';
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return t('security.justNow');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('security.minutesAgo', { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('security.hoursAgo', { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return t('security.daysAgo', { n: diffDay });
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
 * ActiveSessionsSection: lists all active Supabase Auth sessions for the
 * current user and provides a "Sign out all other sessions" action.
 *
 * Sessions are fetched client-side from GET /api/security/sessions on mount.
 * The DELETE /api/security/sessions endpoint revokes all refresh tokens except
 * the current session, so the user stays logged in on this device.
 */
function ActiveSessionsSection() {
  const t = useTranslations('dashboard');
  const [sessions, setSessions] = useState(null);   // null = loading
  const [fetchErr, setFetchErr] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  // Tracks which individual session IDs are currently being revoked.
  const [revokingIds, setRevokingIds] = useState(new Set());
  const { toast } = useToast();

  // Fetch sessions on first render
  const loadSessions = async () => {
    setFetchErr(null);
    setSessions(null);
    try {
      const res = await fetch('/api/security/sessions');
      if (!res.ok) {
        let msg = t('security.errLoadSessions');
        try { const d = await res.json(); if (typeof d?.error === 'string') msg = d.error; } catch { /* ignore */ }
        setFetchErr(msg);
        return;
      }
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {
      setFetchErr(t('security.networkError'));
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
        let msg = t('security.errSignOut');
        try { const d = await res.json(); if (typeof d?.error === 'string') msg = d.error; } catch { /* ignore */ }
        toast({ message: msg, variant: 'error' });
        return;
      }
      // Remove all non-current sessions from local state
      setSessions(prev => (prev ?? []).filter(s => s.isCurrent));
      toast({
        message: otherSessionCount === 1
          ? t('security.signedOutOne')
          : t('security.signedOutMany', { count: otherSessionCount }),
        variant: 'success',
      });
    } catch {
      toast({ message: t('security.networkError'), variant: 'error' });
    } finally {
      setSigningOut(false);
    }
  };

  // Per-row revoke: calls DELETE /api/security/sessions with the session id.
  const handleRevokeSession = async (sessionId) => {
    if (revokingIds.has(sessionId)) return;
    setRevokingIds(prev => new Set([...prev, sessionId]));
    try {
      const res = await fetch('/api/security/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        let msg = 'Failed to revoke session.';
        try { const d = await res.json(); if (typeof d?.error === 'string') msg = d.error; } catch { /* ignore */ }
        toast({ message: msg, variant: 'error' });
        return;
      }
      setSessions(prev => (prev ?? []).filter(s => s.id !== sessionId));
      toast({ message: 'Session revoked.', variant: 'success' });
    } catch {
      toast({ message: t('security.networkError'), variant: 'error' });
    } finally {
      setRevokingIds(prev => { const n = new Set(prev); n.delete(sessionId); return n; });
    }
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-h">
        <div>
          <div className="title">{t('security.sessionsTitle')}</div>
          <div className="sub">
            {t('security.sessionsSub')}
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
                ? t('security.signingOut')
                : (otherSessionCount === 1 ? t('security.signOutOther') : t('security.signOutOthers', { count: otherSessionCount }))}
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
          <Btn variant="secondary" size="sm" onClick={loadSessions}>{t('security.retry')}</Btn>
        </div>
      )}

      {/* Sessions list */}
      {sessions !== null && sessions.length === 0 && (
        <div className="empty">
          <div className="ico"><Icon name="shield" size={20} /></div>
          <h3>{t('security.noSessionsTitle')}</h3>
          <p>{t('security.noSessionsDesc')}</p>
        </div>
      )}

      {sessions !== null && sessions.length > 0 && (
        <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('security.colDevice')}</th>
              <th>{t('security.colIp')}</th>
              <th>{t('security.colSignedIn')}</th>
              <th>{t('security.colLastActive')}</th>
              <th style={{ minWidth: 80 }}>{t('security.colStatus')}</th>
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
                    {session.ip ?? '–'}
                  </code>
                </td>

                {/* Signed in (created_at) */}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'var(--fg-3)',
                  }}>
                    {formatSessionAge(session.createdAt, t)}
                  </span>
                </td>

                {/* Last active (refreshed_at or updated_at) */}
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'var(--fg-3)',
                  }}>
                    {formatSessionAge(session.lastActiveAt, t)}
                  </span>
                </td>

                {/* Status badge + per-row Revoke for non-current sessions */}
                <td>
                  {session.isCurrent ? (
                    <Badge tone="live" dot="live">{t('security.thisDevice')}</Badge>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Badge tone="neutral">{t('security.active')}</Badge>
                      <Btn
                        variant="danger"
                        size="sm"
                        onClick={() => handleRevokeSession(session.id)}
                        disabled={revokingIds.has(session.id) || signingOut}
                      >
                        {revokingIds.has(session.id) ? 'Revoking…' : 'Revoke'}
                      </Btn>
                    </div>
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
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '–';
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
 * AuditTable: renders a page of audit log entries as a table.
 *
 * Columns: Tool, Inbox, API Key, Timestamp, Status
 */
function AuditTable({ entries }) {
  const t = useTranslations('dashboard');
  // formatAuditTimestamp uses locale/timezone-dependent formatting, which
  // differs between the server (UTC) and the client (local TZ) and triggers a
  // React #418 hydration mismatch on the server-pre-rendered first page.
  // Render timestamps client-only: a stable placeholder during SSR/first paint,
  // then the real local-time value after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (entries.length === 0) {
    return (
      <div className="empty">
        <div className="ico"><Icon name="shield" size={20} /></div>
        <h3>{t('security.noCallsTitle')}</h3>
        <p>
          {t('security.noCallsDesc')}
        </p>
      </div>
    );
  }

  return (
    <div className="tbl-wrap">
    <table className="tbl">
      <thead>
        <tr>
          <th>{t('security.colTool')}</th>
          <th>{t('security.colInbox')}</th>
          <th>{t('security.colApiKey')}</th>
          <th>{t('security.colTimestamp')}</th>
          <th>{t('security.colStatus')}</th>
          <th style={{ minWidth: 64 }}>{t('security.colDuration')}</th>
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
                  –
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
                  –
                </span>
              )}
            </td>

            {/* Timestamp (client-only to avoid TZ-driven hydration mismatch) */}
            <td style={{ whiteSpace: 'nowrap' }}>
              <span
                suppressHydrationWarning
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--fg-3)' }}
              >
                {mounted ? formatAuditTimestamp(entry.createdAt) : '–'}
              </span>
            </td>

            {/* Status badge */}
            <td>
              {entry.status === 'success' ? (
                <Badge tone="live" dot="live">{t('security.statusSuccess')}</Badge>
              ) : entry.status === 'rate_limited' ? (
                <Badge tone="amber" dot="amber">{t('security.statusRateLimited')}</Badge>
              ) : (
                <div>
                  <Badge tone="red" dot="red">{t('security.statusError')}</Badge>
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
                {entry.durationMs != null ? `${entry.durationMs}ms` : '–'}
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
 * SecurityPage: active sessions list + paginated audit log of MCP tool calls.
 *
 * Props:
 *   auditLog: {
 *     entries: AuditEntry[];   // first page, pre-fetched server-side
 *     total: number;           // total row count for pagination
 *     page: number;            // current page (always 0 from server)
 *     pageSize: number;        // rows per page (always 25)
 *   }
 *
 * Subsequent pages are fetched client-side from GET /api/security/audit-log.
 */
export function SecurityPage({ auditLog }) {
  const t = useTranslations('dashboard');
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
        let msg = t('security.errLoadAudit');
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
      setFetchErr(t('security.networkError'));
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
        title={t('security.title')}
        sub={t('security.sub')}
      />

      {/* Active sessions: loaded client-side */}
      <ActiveSessionsSection />

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-h">
          <div>
            <div className="title">{t('security.auditTitle')}</div>
            <div className="sub">
              {total > 0
                ? t('security.auditShowing', { start: rangeStart, end: rangeEnd, total: total.toLocaleString() })
                : t('security.auditSub')}
            </div>
          </div>
          {/* Pagination controls: only shown when there is more than one page */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <span style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                color: 'var(--fg-3)',
                userSelect: 'none',
              }}>
                {t('security.pageOf', { page: page + 1, total: totalPages })}
              </span>
              <Btn
                variant="secondary"
                size="sm"
                icon="chevron"
                onClick={handlePrev}
                disabled={page === 0 || loading}
                title={t('security.prevPage')}
              >
                {''}
              </Btn>
              <Btn
                variant="secondary"
                size="sm"
                icon="chevron"
                onClick={handleNext}
                disabled={page >= totalPages - 1 || loading}
                title={t('security.nextPage')}
              >
                {''}
              </Btn>
            </div>
          )}
        </div>

        {/* Loading overlay: subtle opacity shift while fetching subsequent pages */}
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

        {/* Bottom pagination: mirrors the header controls for long tables */}
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
              {t('security.resultsRange', { start: rangeStart, end: rangeEnd, total: total.toLocaleString() })}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn
                variant="secondary"
                size="sm"
                onClick={handlePrev}
                disabled={page === 0 || loading}
              >
                {t('security.previous')}
              </Btn>
              <Btn
                variant="secondary"
                size="sm"
                onClick={handleNext}
                disabled={page >= totalPages - 1 || loading}
              >
                {t('security.next')}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MembersPage
   Workspace member management: invite form, member list, pending invites.
   ───────────────────────────────────────────────────────────────────────────── */

const ROLE_COLORS = {
  owner:  { bg: 'var(--bg-sunken)',   color: 'var(--fg-2)',    labelKey: 'members.roleOwner'  },
  admin:  { bg: 'var(--cobalt-50)',   color: 'var(--cobalt-700, #1d4ed8)', labelKey: 'members.roleAdmin'  },
  member: { bg: 'var(--live-soft)',   color: 'var(--mint-600)', labelKey: 'members.roleMember' },
  viewer: { bg: 'rgba(245,158,11,.1)', color: 'var(--amber-600, #d97706)', labelKey: 'members.roleViewer' },
};

function RoleBadge({ role }) {
  const t = useTranslations('dashboard');
  const c = ROLE_COLORS[role] ?? ROLE_COLORS.member;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 20,
      background: c.bg,
      color: c.color,
      fontSize: 12,
      fontWeight: 600,
      fontFamily: 'var(--font-sans)',
    }}>
      {t(c.labelKey)}
    </span>
  );
}

function MemberInitials({ displayName, email }) {
  const src = displayName?.trim() || email || '?';
  const parts = src.split(/[\s@]+/);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : src.slice(0, 2).toUpperCase();
  return <Avatar initials={initials} />;
}

export function MembersPage({
  members,
  pendingInvites,
  planLimits,
  userRole,
  currentUserId,
  onInvite,
  onCancelInvite,
  onRemove,
  onChangeRole,
}) {
  const t = useTranslations('dashboard');
  const { toast } = useToast();

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole,  setInviteRole]  = useState('member');
  const [inviting,    setInviting]    = useState(false);
  const [inviteError, setInviteError] = useState(null);

  // Confirm-remove dialog state
  const [confirmRemove, setConfirmRemove] = useState(null); // member object or null
  const [removing,      setRemoving]      = useState(false);

  // Role-change in-flight
  const [changingRole, setChangingRole] = useState(null); // userId or null

  const canManage = userRole === 'owner' || userRole === 'admin';
  // Inviting members is a paid capability: Free is single-user (maxMembers: 1),
  // so once the owner fills the only seat there are no invites. Paid plans are
  // unlimited (maxMembers === null). Backend enforces this too (checkMemberLimit).
  const seatLimit = planLimits?.maxMembers ?? null; // null = unlimited
  const atSeatLimit = seatLimit !== null && members.length >= seatLimit;
  const canInvite = canManage && !atSeatLimit;
  // Team roles (Admin/Viewer) are a separate paid capability. When invites ARE
  // allowed but roles aren't (e.g. Solo), everyone joins as a plain Member.
  const teamRolesEnabled = planLimits?.teamRolesEnabled ?? false;
  const canChangeRoles = userRole === 'owner' && teamRolesEnabled;

  const handleInviteSubmit = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      await onInvite(inviteEmail.trim().toLowerCase(), inviteRole);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err.message ?? t('members.errInviteFailed'));
    } finally {
      setInviting(false);
    }
  };

  const handleRemoveConfirm = async () => {
    if (!confirmRemove || removing) return;
    setRemoving(true);
    try {
      await onRemove(confirmRemove.userId);
      setConfirmRemove(null);
    } catch (err) {
      toast({ message: err.message ?? t('members.errRemoveFailed'), variant: 'error' });
    } finally {
      setRemoving(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    setChangingRole(userId);
    try {
      await onChangeRole(userId, newRole);
    } catch (err) {
      toast({ message: err.message ?? t('members.errRoleFailed'), variant: 'error' });
    } finally {
      setChangingRole(null);
    }
  };

  const handleCancelInvite = async (inviteId) => {
    try {
      await onCancelInvite(inviteId);
    } catch (err) {
      toast({ message: err.message ?? t('members.errCancelFailed'), variant: 'error' });
    }
  };

  return (
    <div className="page">
      <PageHeader
        title={t('members.title')}
        sub={`${members.length === 1 ? t('members.subOne') : t('members.subMany', { count: members.length })}${planLimits?.maxMembers ? t('members.seatLimit', { max: planLimits.maxMembers }) : ''}`}
      />

      {/* ── Invite form (owner/admin only) ─────────────────────────────────── */}
      {canManage && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-h">
            <div>
              <div className="title">{t('members.inviteTitle')}</div>
              <div className="sub">{t('members.inviteSub')}</div>
            </div>
          </div>
          <div className="card-body">
            {!canInvite && (
              <div style={{ fontSize: 13.5, color: 'var(--fg-3)' }}>
                {t('members.inviteUpgradeHint')}
              </div>
            )}
            {canInvite && (
              <form onSubmit={handleInviteSubmit} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <input
                  type="email"
                  placeholder={t('members.invitePlaceholder')}
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  required
                  disabled={inviting}
                  style={{
                    flex: '1 1 220px',
                    padding: '8px 12px',
                    border: '1px solid var(--border-1)',
                    borderRadius: 8,
                    fontSize: 13.5,
                    fontFamily: 'var(--font-sans)',
                    background: 'var(--bg-input, var(--bg-card))',
                    color: 'var(--fg-1)',
                    outline: 'none',
                  }}
                />
                {teamRolesEnabled && (
                  <select
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value)}
                    disabled={inviting}
                    style={{
                      padding: '8px 12px',
                      border: '1px solid var(--border-1)',
                      borderRadius: 8,
                      fontSize: 13.5,
                      fontFamily: 'var(--font-sans)',
                      background: 'var(--bg-input, var(--bg-card))',
                      color: 'var(--fg-1)',
                      cursor: 'pointer',
                    }}
                  >
                    {canChangeRoles && <option value="admin">{t('members.roleAdmin')}</option>}
                    <option value="member">{t('members.roleMember')}</option>
                    <option value="viewer">{t('members.roleViewer')}</option>
                  </select>
                )}
                <Btn variant="primary" type="submit" disabled={inviting || !inviteEmail.trim()}>
                  {inviting ? t('members.sending') : t('members.sendInvite')}
                </Btn>
              </form>
            )}
            {canInvite && !teamRolesEnabled && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--fg-3)' }}>
                {t('members.rolesLockedHint')}
              </div>
            )}
            {inviteError && (
              <div style={{ marginTop: 10, fontSize: 13, color: 'var(--red-600, #dc2626)' }}>
                {inviteError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Member list ─────────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('members.colMember')}</th>
                <th>{t('members.colRole')}</th>
                <th>{t('members.colJoined')}</th>
                {canManage && <th className="right">{''}</th>}
              </tr>
            </thead>
            <tbody>
              {members.map(m => {
                const isCurrentUser = m.userId === currentUserId;
                const isOwner = m.role === 'owner';
                const showActions = canManage && !isOwner && !isCurrentUser;
                return (
                  <tr key={m.userId}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <MemberInitials displayName={m.displayName} email={m.email} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--fg-1)' }}>
                            {m.displayName || m.email}
                            {isCurrentUser && (
                              <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-3)', fontWeight: 400 }}>
                                {t('members.you')}
                              </span>
                            )}
                          </div>
                          {m.displayName && (
                            <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{m.email}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>
                      {canChangeRoles && showActions ? (
                        <select
                          value={m.role}
                          onChange={e => handleRoleChange(m.userId, e.target.value)}
                          disabled={changingRole === m.userId}
                          style={{
                            padding: '4px 8px',
                            border: '1px solid var(--border-1)',
                            borderRadius: 6,
                            fontSize: 12.5,
                            fontFamily: 'var(--font-sans)',
                            background: 'var(--bg-input, var(--bg-card))',
                            color: 'var(--fg-1)',
                            cursor: changingRole === m.userId ? 'wait' : 'pointer',
                          }}
                        >
                          <option value="admin">{t('members.roleAdmin')}</option>
                          <option value="member">{t('members.roleMember')}</option>
                          <option value="viewer">{t('members.roleViewer')}</option>
                        </select>
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </td>
                    <td style={{ color: 'var(--fg-3)', fontSize: 13 }}>
                      {new Date(m.joinedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    {canManage && (
                      <td className="right">
                        {showActions && (
                          <Btn
                            variant="ghost"
                            size="sm"
                            icon="trash"
                            onClick={() => setConfirmRemove(m)}
                            aria-label={t('members.removeMember', { name: m.displayName || m.email })}
                            title={t('members.removeMember', { name: m.displayName || m.email })}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Pending invites ──────────────────────────────────────────────────── */}
      {canManage && pendingInvites.length > 0 && (
        <div className="card">
          <div className="card-h">
            <div>
              <div className="title">{t('members.pendingTitle')}</div>
              <div className="sub">{pendingInvites.length === 1 ? t('members.pendingSubOne') : t('members.pendingSubMany', { count: pendingInvites.length })}</div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('members.colEmail')}</th>
                  <th>{t('members.colRole')}</th>
                  <th>{t('members.colSent')}</th>
                  <th>{t('members.colExpires')}</th>
                  <th className="right">{''}</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvites.map(inv => (
                  <tr key={inv.id}>
                    <td style={{ color: 'var(--fg-1)', fontWeight: 500 }}>{inv.email}</td>
                    <td><RoleBadge role={inv.role} /></td>
                    <td style={{ color: 'var(--fg-3)', fontSize: 13 }}>
                      {new Date(inv.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td style={{ color: 'var(--fg-3)', fontSize: 13 }}>
                      {new Date(inv.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className="right">
                      <Btn
                        variant="ghost"
                        size="sm"
                        icon="x"
                        onClick={() => handleCancelInvite(inv.id)}
                        aria-label={t('members.cancelInviteAria', { email: inv.email })}
                        title={t('members.cancelInvite')}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Confirm-remove dialog ────────────────────────────────────────────── */}
      {confirmRemove && (
        <div className="scrim" onClick={() => { if (!removing) setConfirmRemove(null); }}>
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ width: 420 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-member-dialog-title"
          >
            <div className="modal-h">
              <h2 id="remove-member-dialog-title">{t('members.removeDialogTitle')}</h2>
            </div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fg-2)', lineHeight: 1.6 }}>
                {t.rich('members.removeDialogBody', { ...RICH, name: confirmRemove.displayName || confirmRemove.email })}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                <Btn variant="secondary" onClick={() => { if (!removing) setConfirmRemove(null); }} disabled={removing}>
                  {t('members.cancel')}
                </Btn>
                <Btn variant="destructive" icon="trash" onClick={handleRemoveConfirm} disabled={removing}>
                  {removing ? t('members.removing') : t('members.removeMemberBtn')}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
