import HomeClient from '../../components/marketing/HomeClient';
import { requireLocale } from '@/i18n/require-locale';
import { renderHome } from './home-render';

// Metadata, data and JSON-LD live in ./home-render.tsx, shared with the
// staging-only Homepage Lab routes; this page renders exactly what it did.
export { generateMetadata } from './home-render';

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  requireLocale(locale);
  return renderHome(locale, ({ stripePrices, eurEnabled, businessSeat }) => (
    <HomeClient stripePrices={stripePrices} eurEnabled={eurEnabled} businessSeat={businessSeat} />
  ));
}
