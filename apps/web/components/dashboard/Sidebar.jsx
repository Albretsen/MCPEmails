'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Icon, Avatar } from '../Primitives';
import { createClient } from '@/lib/supabase/client';
import { CreateWorkspaceModal } from './CreateWorkspaceModal';
import { sectionToPath } from './routes';
import { planDisplayName } from '@/lib/stripe/plans';

/* Sidebar.jsx: left nav with mobile-collapsible drawer support. */


/**
 * Sidebar: vertical navigation column.
 *
 * On desktop it is always visible as part of the two-column `.shell` grid.
 * On mobile (≤767px) it becomes a fixed off-canvas drawer:
 *   - `isOpen` controls whether the drawer is slid in.
 *   - `onClose` is called when the user taps the overlay backdrop.
 *   - Clicking a nav item also calls `onClose` so the drawer closes.
 */
export function Sidebar({ route, setRoute, counts, user, workspace, workspaces = [], activeWorkspaceId, canCreateWorkspace = false, isOpen, onClose }) {
  const tr = useTranslations('dashboardChrome');
  const router = useRouter();
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wsRef = useRef(null);

  // Close the workspace menu on outside click / Escape.
  useEffect(() => {
    if (!wsMenuOpen) return;
    function onDown(e) {
      if (wsRef.current && !wsRef.current.contains(e.target)) setWsMenuOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setWsMenuOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [wsMenuOpen]);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) ?? {
    id: workspace?.id,
    displayName: workspace?.slug,
    slug: workspace?.slug,
    plan: workspace?.plan ?? 'free',
  };

  // The plan a newly created workspace would inherit. Paid workspaces (incl.
  // any legacy enterprise) are "Scale".
  const inheritPlanLabel = 'Scale';

  async function switchWorkspace(id) {
    setWsMenuOpen(false);
    if (!id || id === activeWorkspaceId || switching) return;
    setSwitching(true);
    try {
      await fetch('/api/workspaces/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: id }),
      });
      window.location.assign('/dashboard');
    } catch {
      setSwitching(false);
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    // Use scope:'local' to clear only the local session tokens without waiting
    // for Supabase's server-side refresh-token revocation (which can return 503).
    // The client-side session is always cleared regardless of network/server errors,
    // so the user is always logged out on this device even if the server call fails.
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch {
      // Server-side revocation failed (e.g. 503). The local tokens have already
      // been cleared by supabase-js before the network call, so we continue.
    }
    // Always redirect home — no usable session remains in the browser.
    router.push('/');
  }

  function handleNavClick(e, id) {
    // Let the browser handle modifier-clicks (open in new tab/window) natively;
    // the items are real links, so only intercept plain left-clicks for SPA nav.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setRoute(id);
    // Close the drawer on mobile after navigation
    if (onClose) onClose();
  }

  const items = [
    { id: "overview", label: tr('sidebar.navOverview'), icon: "activity" },
    { id: "inboxes",  label: tr('sidebar.navInboxes'),  icon: "inbox",   count: counts.inboxes },
    { id: "keys",     label: tr('sidebar.navKeys'),     icon: "key",     count: counts.keys },
    { id: "members",  label: tr('sidebar.navMembers'),  icon: "users",   count: counts.members > 1 ? counts.members : undefined },
    { id: "usage",    label: tr('sidebar.navUsage'),    icon: "zap" },
    { id: "workflows", label: 'Workflows', icon: "activity" },
    { id: "approvals", label: tr('sidebar.navApprovals'), icon: "shield" },
  ];
  const settings = [
    { id: "settings", label: tr('sidebar.navSettings'), icon: "settings" },
    { id: "security", label: tr('sidebar.navSecurity'), icon: "shield" },
  ];

  return (
    <>
      {/* Mobile overlay backdrop: covers main content when drawer is open */}
      <div
        className={'sidebar-overlay' + (isOpen ? ' open' : '')}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        id="dashboard-sidebar"
        className={'sidebar' + (isOpen ? ' sidebar-open' : '')}
        aria-label="Dashboard navigation"
      >
        <div className="brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        {/* Workspace switcher */}
        <div className="ws-switcher" ref={wsRef}>
          <button
            type="button"
            className="ws-switcher-btn"
            onClick={() => setWsMenuOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={wsMenuOpen}
            disabled={switching}
          >
            <span className="ws-glyph" aria-hidden="true">
              {(activeWs.displayName || activeWs.slug || 'W').slice(0, 1).toUpperCase()}
            </span>
            <span className="ws-meta">
              <span className="ws-name">{activeWs.displayName || activeWs.slug}</span>
              <span className="ws-plan">{tr('sidebar.planSuffix', { plan: planDisplayName(activeWs.plan) })}</span>
            </span>
            <Icon name="chevron" size={14} color="var(--fg-3)" />
          </button>

          {wsMenuOpen && (
            <div className="ws-menu" role="listbox">
              <div className="ws-menu-label">{tr('sidebar.workspacesLabel')}</div>
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={w.id === activeWorkspaceId}
                  className={'ws-menu-item' + (w.id === activeWorkspaceId ? ' active' : '')}
                  onClick={() => switchWorkspace(w.id)}
                >
                  <span className="ws-glyph sm" aria-hidden="true">
                    {(w.displayName || w.slug || 'W').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="ws-meta">
                    <span className="ws-name">{w.displayName || w.slug}</span>
                    <span className="ws-plan">{tr('sidebar.planSuffix', { plan: planDisplayName(w.plan) })}{w.isOwner ? '' : ` · ${tr('sidebar.memberSuffix')}`}</span>
                  </span>
                  {w.id === activeWorkspaceId && <Icon name="check" size={14} color="var(--brand)" />}
                </button>
              ))}

              <div className="ws-menu-sep" />

              {canCreateWorkspace ? (
                <button
                  type="button"
                  className="ws-menu-item ws-menu-action"
                  onClick={() => { setWsMenuOpen(false); setShowCreateWorkspace(true); }}
                >
                  <span className="ws-glyph sm plus" aria-hidden="true"><Icon name="plus" size={13} color="var(--brand)" /></span>
                  <span className="ws-meta"><span className="ws-name">{tr('sidebar.newWorkspace')}</span></span>
                </button>
              ) : (
                <a href="/dashboard/settings?upgrade=pro&interval=month" className="ws-menu-item ws-menu-upsell">
                  <span className="ws-glyph sm plus" aria-hidden="true"><Icon name="zap" size={13} color="var(--brand)" /></span>
                  <span className="ws-meta">
                    <span className="ws-name">{tr('sidebar.newWorkspace')}</span>
                    <span className="ws-plan">{tr('sidebar.newWorkspaceUpsell')}</span>
                  </span>
                </a>
              )}
            </div>
          )}
        </div>

        <nav className="nav">
          <div className="section-label">{tr('sidebar.sectionWorkspace')}</div>
          {items.map(it => (
            <a key={it.id}
               href={sectionToPath(it.id)}
               className={"nav-item" + (route === it.id ? " active" : "")}
               aria-current={route === it.id ? "page" : undefined}
               onClick={e => handleNavClick(e, it.id)}>
              <Icon name={it.icon} size={16} />
              <span>{it.label}</span>
              {it.count != null ? <span className="count">{it.count}</span> : null}
            </a>
          ))}

          <div className="section-label">{tr('sidebar.sectionAccount')}</div>
          {settings.map(it => (
            <a key={it.id}
               href={sectionToPath(it.id)}
               className={"nav-item" + (route === it.id ? " active" : "")}
               aria-current={route === it.id ? "page" : undefined}
               onClick={e => handleNavClick(e, it.id)}>
              <Icon name={it.icon} size={16} />
              <span>{it.label}</span>
            </a>
          ))}
        </nav>

        <div className="footer-user">
          <Avatar initials={user?.initials ?? '?'} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {user?.displayName || user?.email || tr('sidebar.accountFallback')}
            </div>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--fg-3)", textTransform: "capitalize" }}>
              {tr('sidebar.planSuffix', { plan: planDisplayName(workspace?.plan) })}
            </div>
          </div>
          <button
            onClick={handleSignOut}
            title={tr('sidebar.signOut')}
            style={{
              background: "none",
              border: "none",
              padding: 8,
              cursor: "pointer",
              color: "var(--fg-3)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 36,
              minHeight: 36,
              transition: "color 120ms var(--ease-out), background 120ms var(--ease-out)",
            }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--fg-1)"; e.currentTarget.style.background = "var(--ink-100)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--fg-3)"; e.currentTarget.style.background = "none"; }}
          >
            <Icon name="logout" size={14} color="currentColor" />
          </button>
        </div>
      </aside>

      {showCreateWorkspace && (
        <CreateWorkspaceModal
          onClose={() => setShowCreateWorkspace(false)}
          planLabel={inheritPlanLabel}
        />
      )}
    </>
  );
}

/**
 * Topbar: horizontal bar at the top of the main column.
 *
 * `onMenuOpen` is called when the hamburger button is tapped on mobile.
 * The hamburger button is hidden on desktop via CSS (`.menu-btn`).
 */
/**
 * TopbarMcpLink: compact copy-to-clipboard control for the workspace MCP
 * endpoint, surfaced in the topbar so the URL is reachable from any dashboard
 * page. Shows the URL without its scheme to stay compact; clicking copies the
 * full URL.
 */
function TopbarMcpLink({ url }) {
  const tr = useTranslations('dashboardChrome');
  const [copied, setCopied] = useState(false);
  const display = url.replace(/^https?:\/\//, '');
  const copy = () => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      className="mcp-link"
      onClick={copy}
      title={tr('topbar.mcpCopyTitle')}
      aria-label={copied ? tr('topbar.mcpCopied') : tr('topbar.mcpCopy')}
    >
      <span className="mcp-link-label">{tr('topbar.mcpLabel')}</span>
      <code className="mcp-link-url">{display}</code>
      <Icon name={copied ? 'check' : 'copy'} size={13} color={copied ? 'var(--mint-500)' : 'var(--fg-3)'} />
    </button>
  );
}

export function Topbar({ route, workspace, mcpUrl, onMenuOpen, onOpenSearch, sidebarOpen }) {
  const tr = useTranslations('dashboardChrome');
  const labels = {
    overview: tr('sidebar.navOverview'),
    inboxes:  tr('sidebar.navInboxes'),
    keys:     tr('sidebar.navKeys'),
    members:  tr('sidebar.navMembers'),
    usage:    tr('sidebar.navUsage'),
    workflows: 'Workflows',
    approvals: tr('sidebar.navApprovals'),
    settings: tr('sidebar.navSettings'),
    security: tr('sidebar.navSecurity'),
  };
  return (
    <header className="topbar">
      {/* Hamburger: only visible on mobile (display:none on desktop via CSS) */}
      <button
        className="menu-btn"
        onClick={onMenuOpen}
        aria-label={sidebarOpen ? tr('sidebar.closeMenu') : tr('sidebar.openMenu')}
        aria-expanded={sidebarOpen ? 'true' : 'false'}
        aria-controls="dashboard-sidebar"
      >
        <Icon name="menu" size={20} color="currentColor" />
      </button>

      <div className="crumbs">
        <span>{workspace?.displayName ?? workspace?.display_name ?? workspace?.slug ?? tr('sidebar.workspaceFallback')}</span>
        <span className="sep">/</span>
        <span className="here">{labels[route]}</span>
      </div>
      <div className="grow"></div>
      {mcpUrl ? <TopbarMcpLink url={mcpUrl} /> : null}
      <button
        type="button"
        className="search"
        onClick={onOpenSearch}
        aria-label={tr('sidebar.openSearch')}
      >
        <Icon name="search" size={14} color="var(--fg-3)" />
        <span className="search-placeholder">{tr('sidebar.searchPlaceholder')}</span>
        <span className="kbd">⌘K</span>
      </button>
    </header>
  );
}
