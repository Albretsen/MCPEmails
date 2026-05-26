'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, Btn, Avatar } from '../Primitives';
import { createClient } from '@/lib/supabase/client';

/* Sidebar.jsx — left nav with mobile-collapsible drawer support. */


/**
 * Sidebar — vertical navigation column.
 *
 * On desktop it is always visible as part of the two-column `.shell` grid.
 * On mobile (≤767px) it becomes a fixed off-canvas drawer:
 *   - `isOpen` controls whether the drawer is slid in.
 *   - `onClose` is called when the user taps the overlay backdrop.
 *   - Clicking a nav item also calls `onClose` so the drawer closes.
 */
export function Sidebar({ route, setRoute, counts, user, workspace, isOpen, onClose }) {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/');
  }

  function handleNavClick(id) {
    setRoute(id);
    // Close the drawer on mobile after navigation
    if (onClose) onClose();
  }

  const items = [
    { id: "overview", label: "Overview",   icon: "activity" },
    { id: "inboxes",  label: "Inboxes",    icon: "inbox",   count: counts.inboxes },
    { id: "keys",     label: "API keys",   icon: "key",     count: counts.keys },
    { id: "members",  label: "Members",    icon: "users",   count: counts.members > 1 ? counts.members : undefined },
    { id: "usage",    label: "Usage",      icon: "zap" },
  ];
  const settings = [
    { id: "settings", label: "Settings",   icon: "settings" },
    { id: "security", label: "Security",   icon: "shield" },
  ];

  return (
    <>
      {/* Mobile overlay backdrop — covers main content when drawer is open */}
      <div
        className={'sidebar-overlay' + (isOpen ? ' open' : '')}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside className={'sidebar' + (isOpen ? ' sidebar-open' : '')}>
        <div className="brand">
          <img src="/logo-wordmark.svg" alt="mcpemails" />
        </div>

        <nav className="nav">
          <div className="section-label">Workspace</div>
          {items.map(it => (
            <div key={it.id}
                 className={"nav-item" + (route === it.id ? " active" : "")}
                 onClick={() => handleNavClick(it.id)}
                 role="button"
                 tabIndex={0}
                 onKeyDown={e => e.key === 'Enter' && handleNavClick(it.id)}>
              <Icon name={it.icon} size={16} />
              <span>{it.label}</span>
              {it.count != null ? <span className="count">{it.count}</span> : null}
            </div>
          ))}

          <div className="section-label">Account</div>
          {settings.map(it => (
            <div key={it.id}
                 className={"nav-item" + (route === it.id ? " active" : "")}
                 onClick={() => handleNavClick(it.id)}
                 role="button"
                 tabIndex={0}
                 onKeyDown={e => e.key === 'Enter' && handleNavClick(it.id)}>
              <Icon name={it.icon} size={16} />
              <span>{it.label}</span>
            </div>
          ))}
        </nav>

        <div className="footer-user">
          <Avatar initials={user?.initials ?? '?'} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {user?.displayName || user?.email || 'Account'}
            </div>
            <div style={{ fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--fg-3)", textTransform: "capitalize" }}>
              {workspace?.plan ?? 'free'} plan
            </div>
          </div>
          <button
            onClick={handleSignOut}
            title="Sign out"
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
    </>
  );
}

/**
 * Topbar — horizontal bar at the top of the main column.
 *
 * `onMenuOpen` is called when the hamburger button is tapped on mobile.
 * The hamburger button is hidden on desktop via CSS (`.menu-btn`).
 */
export function Topbar({ route, workspace, onMenuOpen }) {
  const labels = {
    overview: "Overview",
    inboxes:  "Inboxes",
    keys:     "API keys",
    members:  "Members",
    usage:    "Usage",
    settings: "Settings",
    security: "Security",
  };
  return (
    <header className="topbar">
      {/* Hamburger — only visible on mobile (display:none on desktop via CSS) */}
      <button
        className="menu-btn"
        onClick={onMenuOpen}
        aria-label="Open navigation menu"
      >
        <Icon name="menu" size={20} color="currentColor" />
      </button>

      <div className="crumbs">
        <span>{workspace?.slug ?? 'workspace'}</span>
        <span className="sep">/</span>
        <span className="here">{labels[route]}</span>
      </div>
      <div className="grow"></div>
      <div className="search">
        <Icon name="search" size={14} color="var(--fg-3)" />
        <input placeholder="Search docs, tools, settings…" />
        <span className="kbd">⌘K</span>
      </div>
      <Btn variant="ghost" size="sm" icon="bell">{""}</Btn>
    </header>
  );
}
