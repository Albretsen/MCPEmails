import '../styles/theme.css';
import '../styles/colors_and_type.css';
import '../styles/marketing.css';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: 'mcpemails · Give your AI agent an inbox.',
    template: '%s · mcpemails',
  },
  description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client.',
  openGraph: {
    type: 'website',
    siteName: 'mcpemails',
    title: 'mcpemails · Give your AI agent an inbox.',
    description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client.',
    url: APP_URL,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'mcpemails: Give your AI agent an inbox',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@mcpemails',
    creator: '@mcpemails',
    title: 'mcpemails · Give your AI agent an inbox.',
    description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client.',
    images: ['/og.png'],
  },
  icons: {
    icon: '/favicon.svg',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem("mcpe-theme") || "light";
                  document.documentElement.setAttribute("data-theme", t);
                } catch(e) {
                  document.documentElement.setAttribute("data-theme", "light");
                }
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
