import PricingClient from '../../components/marketing/PricingClient';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';

export const metadata = {
  title: 'Pricing',
  description: 'Simple, transparent pricing for AI agents that read and send email. Free plan available. No card required.',
  alternates: {
    canonical: `${APP_URL}/pricing`,
  },
  openGraph: {
    type: 'website',
    url: `${APP_URL}/pricing`,
    title: 'Pricing · mcpemails',
    description: 'Simple, transparent pricing for AI agents that read and send email. Free plan available. No card required.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'mcpemails Pricing — Free, Pro, and Enterprise plans',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pricing · mcpemails',
    description: 'Simple, transparent pricing for AI agents that read and send email. Free plan available.',
    images: ['/og.png'],
  },
};

export default function PricingPage() {
  return <PricingClient />;
}
