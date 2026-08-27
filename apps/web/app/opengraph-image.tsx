import { ImageResponse } from 'next/og';

// Route segment config
export const runtime = 'edge';
export const alt = 'mcpemails: Give your AI agent an inbox';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Brand tokens (mirrored from styles/colors_and_type.css)
const COBALT = '#2547E5'; // --cobalt-500 (brand)
const COBALT_700 = '#16299A';
const COBALT_50 = '#EEF2FF';
const MINT = '#1FCB8B'; // --mint-500
const INK_900 = '#0B1020'; // --fg-1
const INK_700 = '#2F3447'; // --fg-2
const INK_200 = '#DEE1EB'; // dot-grid color
const SURFACE = '#FFFFFF'; // --bg-surface

// The mcpemails envelope mark (matches public/logo-mark.svg) sized for the card.
function LogoMark({ scale = 1 }: { scale?: number }) {
  const s = 48 * scale;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48" fill="none">
      <rect x="4" y="11" width="40" height="28" rx="5" stroke={COBALT} strokeWidth="2.6" />
      <path
        d="M5.5 13.5 L24 27 L42.5 13.5"
        stroke={COBALT}
        strokeWidth="2.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="39" cy="12" r="5.5" fill={MINT} stroke={SURFACE} strokeWidth="2.2" />
    </svg>
  );
}

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          // Dotted-grid hero background on a white surface (matches .hero).
          backgroundColor: SURFACE,
          backgroundImage: `radial-gradient(${INK_200} 1.4px, transparent 1.5px)`,
          backgroundSize: '24px 24px',
          fontFamily: 'sans-serif',
          position: 'relative',
        }}
      >
        {/* Soft cobalt glow, top-right, echoing the hero accent */}
        <div
          style={{
            position: 'absolute',
            top: -180,
            right: -120,
            width: 560,
            height: 560,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(37,71,229,0.10), rgba(37,71,229,0))',
            display: 'flex',
          }}
        />

        {/* Wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <LogoMark scale={1.05} />
          <span
            style={{
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: INK_900,
            }}
          >
            mcpemails
          </span>
        </div>

        {/* Headline + tagline */}
        <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 980 }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              fontSize: 96,
              fontWeight: 800,
              lineHeight: 1.02,
              letterSpacing: '-0.035em',
              color: INK_900,
            }}
          >
            <span>Give your AI agent an&nbsp;</span>
            <span style={{ color: COBALT }}>inbox.</span>
          </div>
          <p
            style={{
              marginTop: 28,
              fontSize: 30,
              lineHeight: 1.35,
              color: INK_700,
              maxWidth: 880,
            }}
          >
            Connect your email to Claude, Cursor, or any MCP client. Read, send, search,
            and reply via the Model Context Protocol.
          </p>
        </div>

        {/* Footer row: pill chips + domain */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: 14 }}>
            {['Free to start', 'No card required', 'Email never stored'].map((label) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 20px',
                  borderRadius: 999,
                  backgroundColor: COBALT_50,
                  border: '1px solid rgba(37,71,229,0.18)',
                  fontSize: 22,
                  fontWeight: 500,
                  color: COBALT_700,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: MINT,
                  }}
                />
                {label}
              </div>
            ))}
          </div>
          <span style={{ fontSize: 26, fontWeight: 600, color: COBALT }}>mcpemails.com</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
