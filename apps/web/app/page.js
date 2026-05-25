import HomeClient from '../components/marketing/HomeClient';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  title: 'mcpemails · Give your AI agent an inbox.',
  description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client. Read, send, search, and reply to email via the Model Context Protocol.',
  alternates: {
    canonical: APP_URL,
  },
  openGraph: {
    type: 'website',
    url: APP_URL,
    title: 'mcpemails · Give your AI agent an inbox.',
    description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client. Read, send, search, and reply to email via the Model Context Protocol.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'mcpemails — Give your AI agent an inbox',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'mcpemails · Give your AI agent an inbox.',
    description: 'Connect your email accounts to Claude, Cursor, or any MCP-compatible client.',
    images: ['/og.png'],
  },
};

export default function HomePage() {
  return <HomeClient />;
}
