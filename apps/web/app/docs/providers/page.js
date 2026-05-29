import ProvidersClient from '../../../components/marketing/ProvidersClient';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  title: 'Provider Support',
  description: 'See which email providers MCPEmails supports and which features are available per provider: Gmail, Outlook, Fastmail, iCloud, Yahoo, Zoho, Yandex, and Generic IMAP.',
  alternates: {
    canonical: `${APP_URL}/docs/providers`,
  },
  openGraph: {
    type: 'website',
    url: `${APP_URL}/docs/providers`,
    title: 'Provider Support · mcpemails',
    description: 'Feature support matrix for Gmail, Outlook, Fastmail, iCloud, Yahoo, Zoho, Yandex, and Generic IMAP.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'MCPEmails Provider Support',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Provider Support · mcpemails',
    description: 'Feature support matrix for every email provider MCPEmails connects.',
    images: ['/og.png'],
  },
};

export default function ProvidersPage() {
  return <ProvidersClient />;
}
