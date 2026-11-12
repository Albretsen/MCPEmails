import { notFound } from 'next/navigation';
import Variant from 'home-lab-v08';
import { isStaging } from '@/lib/env/app-env';
import { requireLocale } from '@/i18n/require-locale';
import { renderHome } from '../../home-render';

// Homepage Lab variant v08, staging only. The proxy rewrites `/?home=v08` (or
// the home_lab cookie) to this route so the page ships only this variant's
// CSS. `home-lab-v08` is a null stub on non-staging builds (next.config.js),
// and the route 404s there.
export { generateMetadata } from '../../home-render';

export default async function HomeLabV08Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  requireLocale(locale);
  if (process.env.NEXT_PUBLIC_APP_ENV !== 'staging' || !isStaging() || locale !== 'en') notFound();
  return renderHome(locale, (props) => <Variant {...props} />, 'v08');
}
