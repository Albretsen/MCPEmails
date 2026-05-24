import '../styles/theme.css';
import '../styles/colors_and_type.css';
import '../styles/marketing.css';

export const metadata = {
  title: 'mcpemails · Give your AI agent an inbox.',
  description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client.',
  icons: {
    icon: '/favicon.svg',
  },
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
