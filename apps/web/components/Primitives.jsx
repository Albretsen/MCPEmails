'use client';

/* Primitives.jsx: Icons, Badge, Button, Avatar. */

const I = {
  mail:     <path d="M2 6l10 7 10-7M2 6h20v12H2z" />,
  inbox:    <g><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></g>,
  key:      <g><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></g>,
  activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>,
  settings: <g><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></g>,
  search:   <g><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></g>,
  plus:     <g><path d="M12 5v14M5 12h14"/></g>,
  check:    <polyline points="20 6 9 17 4 12"/>,
  x:        <g><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></g>,
  chevron:  <path d="M9 18l6-6-6-6"/>,
  copy:     <g><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></g>,
  shield:   <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
  trash:    <g><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></g>,
  refresh:  <g><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></g>,
  bell:     <g><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></g>,
  download: <g><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></g>,
  zap:      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  eye:      <g><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></g>,
  eyeoff:   <g><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></g>,
  logout:   <g><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></g>,
  menu:     <g><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></g>,
  users:    <g><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></g>,
};

export function Icon({ name, size = 16, color = "currentColor", strokeWidth = 1.75, className = "" }) {
  const glyph = I[name];
  if (!glyph) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke={color} strokeWidth={strokeWidth}
         strokeLinecap="round" strokeLinejoin="round" className={className}>
      {glyph}
    </svg>
  );
}

export function Badge({ tone = "neutral", dot, children }) {
  const cls = "badge b-" + tone;
  return (
    <span className={cls}>
      {dot ? <span className={"dot " + dot}></span> : null}
      {children}
    </span>
  );
}

export function Btn({ variant = "primary", size = "md", icon, children, onClick, type, className = "", disabled = false, title, "aria-label": ariaLabel }) {
  const cls = "btn btn-" + variant + (size === "sm" ? " btn-sm" : "") + (disabled ? " btn-disabled" : "") + " " + className;
  return (
    <button type={type || "button"} className={cls.trim()} onClick={onClick} disabled={disabled} title={title} aria-label={ariaLabel}>
      {icon ? <Icon name={icon} size={size === "sm" ? 13 : 14} className="btn-ico" /> : null}
      {children}
    </button>
  );
}

export function Avatar({ initials = "JR" }) {
  return <div className="avatar">{initials}</div>;
}

export function ProviderLogo({ kind, size = 22 }) {
  // Tiny inline brand glyphs: only the recognizable parts, neutral palette.
  if (kind === "gmail") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="5" width="20" height="14" rx="2" stroke="#0B1020" strokeWidth="1.6"/>
      <path d="M3 6l9 7 9-7" stroke="#E5484D" strokeWidth="1.6" strokeLinejoin="round"/>
    </svg>
  );
  if (kind === "outlook") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="14" height="16" rx="2" fill="#0078D4"/>
      <text x="9" y="16" textAnchor="middle" fontFamily="Geist, sans-serif" fontWeight="700" fontSize="11" fill="#fff">O</text>
      <rect x="14" y="8" width="8" height="8" rx="1" fill="#0B1020"/>
    </svg>
  );
  if (kind === "imap") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#0B1020" strokeWidth="1.6" strokeLinecap="round">
      <rect x="2" y="4" width="20" height="6" rx="1.5"/>
      <rect x="2" y="14" width="20" height="6" rx="1.5"/>
      <circle cx="6" cy="7" r="0.8" fill="#0B1020"/>
      <circle cx="6" cy="17" r="0.8" fill="#0B1020"/>
    </svg>
  );
  if (kind === "fastmail") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="20" height="16" rx="2" fill="#1B55E3"/>
      <path d="M6 9h12M6 12h8M6 15h5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
  if (kind === "icloud") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M7.5 18.5h9.2a3.3 3.3 0 0 0 .3-6.58 4.5 4.5 0 0 0-8.63-1.6A3.75 3.75 0 0 0 7.5 18.5z"
        fill="#3B9BE3"/>
    </svg>
  );
  if (kind === "yahoo") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="3" width="20" height="18" rx="3" fill="#6001D2"/>
      <path d="M7 8l3 5v3M13 8l-3 5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="16.5" cy="15.5" r="1.3" fill="#fff"/>
    </svg>
  );
  if (kind === "zoho") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4" width="20" height="16" rx="2" fill="#0B1020"/>
      <path d="M6 9h6l-6 6h6" stroke="#E42527" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="14.5" y="9" width="4" height="6" rx="2" stroke="#F9B21D" strokeWidth="1.8"/>
    </svg>
  );
  if (kind === "yandex") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9.5" fill="#FC3F1D"/>
      <path d="M13 6.5h-1.4c-1.7 0-2.9 1.1-2.9 2.8 0 1.3.6 2 1.8 2.8L8 17.5h1.6l2.2-3.9h.8v3.9H14V6.5z
        M13 12.2h-.7c-1 0-1.7-.5-1.7-1.7 0-1.2.6-1.8 1.7-1.8h.7v3.5z" fill="#fff"/>
    </svg>
  );
  return null;
}
