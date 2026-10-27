import { CLIENT_LOGOS } from '../dashboard/clientLogos';

/**
 * Chip id -> the client's logo glyph and brand colour (the same pairs as
 * src/lib/clients/clients.mjs). `curl` has no product logo, so it gets a
 * terminal glyph.
 */
const CHIP_LOGOS = {
  claude: ['claude', '#D97757'],
  claude_code: ['claude', '#D97757'],
  chatgpt: ['chatgpt', '#000000'],
  cursor: ['cursor', '#000000'],
  vscode: ['vscode', '#0078D4'],
  cline: ['cline', '#18181B'],
  windsurf: ['windsurf', '#0B100F'],
  gemini: ['gemini', '#8E75B2'],
  zed: ['zed', '#084CCF'],
  jetbrains: ['jetbrains', '#000000'],
  raycast: ['raycast', '#FF6363'],
  warp: ['warp', '#01A4FF'],
  curl: ['curl', '#073551'],
};

/** A white glyph on a tile in the client's colour. `round` makes it a circle. */
export function ClientLogo({ client, size = 40, round = false }) {
  const [key, color] = CHIP_LOGOS[client] ?? [null, 'var(--ink-300)'];
  const glyph = key ? CLIENT_LOGOS[key] : null;
  const inner = Math.round(size * 0.58);
  return (
    <span
      className="onb-logo"
      aria-hidden="true"
      style={{ width: size, height: size, borderRadius: round ? 999 : Math.round(size * 0.26), background: color }}
    >
      {glyph && (
        <svg width={inner} height={inner} viewBox={glyph.viewBox} fill="#fff">
          <path d={glyph.d} fillRule={glyph.fillRule} />
        </svg>
      )}
    </span>
  );
}

/** The MCPEmails mark on a light tile (public/logo-mark.svg, inlined). */
export function MarkLogo({ size = 40 }) {
  return (
    <span className="onb-logo onb-logo-plain" aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}>
      <svg width={Math.round(size * 0.66)} height={Math.round(size * 0.66)} viewBox="0 0 48 48" fill="none">
        <rect x="4" y="11" width="40" height="28" rx="5" stroke="var(--brand)" strokeWidth="2.6" />
        <path d="M5.5 13.5 L24 27 L42.5 13.5" stroke="var(--brand)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx="39" cy="12" r="5.5" fill="#1FCB8B" stroke="var(--bg-surface)" strokeWidth="2.2" />
      </svg>
    </span>
  );
}

/** A plain envelope: the user's own inbox. */
export function InboxLogo({ size = 40 }) {
  const inner = Math.round(size * 0.5);
  return (
    <span className="onb-logo onb-logo-muted" aria-hidden="true" style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }}>
      <svg width={inner} height={inner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3.5 6.5 8.5 6 8.5-6" />
      </svg>
    </span>
  );
}
