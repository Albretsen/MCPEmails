import DocsClient from '../../components/marketing/DocsClient';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  title: 'Docs',
  description: 'Get started with MCPEmails in minutes. Quick-start guide, tool reference, and example responses for Gmail, Outlook, and IMAP agents.',
  alternates: {
    canonical: `${APP_URL}/docs`,
  },
  openGraph: {
    type: 'website',
    url: `${APP_URL}/docs`,
    title: 'Docs · mcpemails',
    description: 'Get started with MCPEmails in minutes. Quick-start guide, tool reference, and example responses for Gmail, Outlook, and IMAP agents.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'mcpemails Developer Documentation',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Docs · mcpemails',
    description: 'Quick-start guide and tool reference for the MCPEmails MCP server.',
    images: ['/og.png'],
  },
};

export default function DocsPage() {
  return <DocsClient />;
}
