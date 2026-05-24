'use client';

import { useState } from 'react';
import { Icon, Btn, Avatar } from '../Primitives';

/* Sidebar.jsx — left nav. */


export function Sidebar({ route, setRoute, counts }) {
  const items = [
    { id: "overview", label: "Overview",   icon: "activity" },
    { id: "inboxes",  label: "Inboxes",    icon: "inbox", count: counts.inboxes },
    { id: "keys",     label: "API keys",   icon: "key",   count: counts.keys },
    { id: "usage",    label: "Usage",      icon: "zap" },
  ];
  const settings = [
    { id: "settings", label: "Settings",   icon: "settings" },
    { id: "security", label: "Security",   icon: "shield" },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/logo-wordmark.svg" alt="mcpemails" />
      </div>

      <nav className="nav">
        <div className="section-label">Workspace</div>
        {items.map(it => (
          <div key={it.id}
               className={"nav-item" + (route === it.id ? " active" : "")}
               onClick={() => setRoute(it.id)}>
            <Icon name={it.icon} size={16} />
            <span>{it.label}</span>
            {it.count != null ? <span className="count">{it.count}</span> : null}
          </div>
        ))}

        <div className="section-label">Account</div>
        {settings.map(it => (
          <div key={it.id}
               className={"nav-item" + (route === it.id ? " active" : "")}
               onClick={() => setRoute(it.id)}>
            <Icon name={it.icon} size={16} />
            <span>{it.label}</span>
          </div>
        ))}
      </nav>

      <div className="footer-user">
        <Avatar initials="JR" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, color: "var(--fg-1)" }}>Jordan Reyes</div>
          <div style={{ fontFamily: "var(--font-sans)", fontSize: 11.5, color: "var(--fg-3)" }}>Pro plan</div>
        </div>
        <Icon name="chevron" size={14} color="var(--fg-3)" />
      </div>
    </aside>
  );
}

export function Topbar({ route }) {
  const labels = {
    overview: "Overview",
    inboxes: "Inboxes",
    keys: "API keys",
    usage: "Usage",
    settings: "Settings",
    security: "Security",
  };
  return (
    <header className="topbar">
      <div className="crumbs">
        <span>jordan-personal</span>
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
