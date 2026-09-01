'use client';

import { useState, useEffect } from 'react';

/* MarketingPrimitives.jsx: extended for tweaks + auth handoff. */

const MI = {
  shield:   <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
  "alert-triangle": <g><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></g>,
  zap:      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>,
  plug:     <g><path d="M12 22v-5M9 8V2M15 8V2M5 8h14v3a7 7 0 0 1-14 0V8z"/></g>,
  ghost:    <g><path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-2 2 2 3-2 3 2 2-2 3 2V10a8 8 0 0 0-8-8z"/></g>,
  eu:       <g><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></g>,
  globe:    <g><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z"/></g>,
  check:    <polyline points="20 6 9 17 4 12"/>,
  arrow:    <g><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></g>,
  mail:     <g><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 6l10 7 10-7"/></g>,
  inbox:    <g><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></g>,
  cpu:      <g><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></g>,
  server:   <g><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></g>,
  moon:     <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>,
  sun:      <g><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></g>,
  github:   <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>,
  google:   <g><path d="M22 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.6c-.2 1.3-1 2.4-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.6z" fill="#4285F4"/><path d="M12 22c2.9 0 5.3-.9 7-2.5l-3.4-2.6c-1 .6-2.2 1-3.6 1-2.7 0-5.1-1.9-5.9-4.4H2.5v2.7C4.3 19.7 7.9 22 12 22z" fill="#34A853"/><path d="M6.1 13.5c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V6.8H2.5C1.7 8.3 1.3 10.1 1.3 12s.4 3.7 1.2 5.2l3.6-2.7z" fill="#FBBC05"/><path d="M12 5.4c1.5 0 2.9.5 4 1.6l3-3C17.2 2.3 14.7 1.3 12 1.3 7.9 1.3 4.3 3.6 2.5 6.8l3.6 2.7C7 7 9.3 5.4 12 5.4z" fill="#EA4335"/></g>,
  lock:     <g><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></g>,
  refresh:  <g><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></g>,
  trash:    <g><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></g>,
  copy:     <g><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></g>,
};

export function MIcon({ name, size = 18, color = "currentColor", strokeWidth = 1.75 }) {
  if (!MI[name]) return null;
  // google icon is multi-color/filled, pass through as-is
  if (name === "google") {
    return <svg width={size} height={size} viewBox="0 0 24 24">{MI[name]}</svg>;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
              stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{MI[name]}</svg>;
}

export function MBtn({ variant = "primary", size = "md", icon, children, href, onClick, type, className = "", disabled = false }) {
  const cls = "btn btn-" + variant + (size === "lg" ? " btn-lg" : size === "sm" ? " btn-sm" : "") + " " + className;
  const node = (
    <>
      {children}
      {icon ? <MIcon name={icon} size={14} color="currentColor" /> : null}
    </>
  );
  if (href !== undefined) {
    return <a className={cls.trim()} href={href} onClick={onClick}>{node}</a>;
  }
  return <button type={type || "button"} className={cls.trim()} onClick={onClick} disabled={disabled}>{node}</button>;
}

/* Theme toggle: persists to localStorage and posts to parent (tweak system) */
export function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    return document.documentElement.getAttribute("data-theme") || "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("mcpe-theme", theme); } catch {}
  }, [theme]);
  return (
    <button className="theme-toggle" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} title="Toggle theme">
      <MIcon name={theme === "dark" ? "sun" : "moon"} size={16} color="currentColor"/>
    </button>
  );
}

/* Read initial theme from localStorage before React mounts. */
if (typeof window !== 'undefined') {
  (function applyInitialTheme(){
    try {
      const t = localStorage.getItem("mcpe-theme");
      if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
    } catch {}
  })();
}
