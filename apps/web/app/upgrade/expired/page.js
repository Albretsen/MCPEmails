import Link from 'next/link';
import { headers } from 'next/headers';
import UpgradeShell from '../UpgradeShell';
import { pricingPath, upgradeCopy, upgradeLocale } from '../copy.mjs';

/**
 * Where a chat checkout link (app/u/[token]/route.ts) sends every visit it
 * cannot turn into a Stripe page: a malformed, unknown, expired or used token
 * (all four look the same here, so the route is no existence oracle), plus two
 * reasons the route sets itself:
 *
 *   ?reason=subscribed  the owner already has a plan; sign in to manage it
 *   ?reason=error       something failed on our side
 *
 * Any other value reads as a plain expiry.
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const c = upgradeCopy(upgradeLocale((await headers()).get('accept-language')));
  return {
    title: c.expiredMetaTitle,
    robots: { index: false, follow: false },
    referrer: 'no-referrer',
  };
}

export default async function UpgradeExpiredPage({ searchParams }) {
  const { reason } = (await searchParams) ?? {};
  const locale = upgradeLocale((await headers()).get('accept-language'));
  const c = upgradeCopy(locale);

  const signIn = (
    <Link className="btn btn-secondary" href="/dashboard">{c.signIn}</Link>
  );

  if (reason === 'subscribed') {
    return <UpgradeShell title={c.subscribedTitle} body={c.subscribedBody}>{signIn}</UpgradeShell>;
  }

  const [title, body] =
    reason === 'error' ? [c.errorTitle, c.errorBody] : [c.expiredTitle, c.expiredBody];
  return (
    <UpgradeShell title={title} body={body}>
      {signIn}
      <a className="btn btn-primary" href={pricingPath(locale)}>{c.seePlans}</a>
    </UpgradeShell>
  );
}
