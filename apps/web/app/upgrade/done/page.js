import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { checkoutLinkStatus } from '@/lib/stripe/checkout-link';
import { checkoutSessionIdOrNull } from '@/lib/email/abandoned-checkout';
import UpgradeShell from '../UpgradeShell';
import ActivationStatus from './ActivationStatus';
import { upgradeCopy, upgradeLocale } from '../copy.mjs';

/**
 * The success_url of a chat checkout link's Stripe session
 * (/upgrade/done?session_id=cs_...). Public: the buyer was never signed in.
 *
 * It shows ONE thing, whether Personal is active yet, and what to do next: go
 * back to the chat and say continue, which makes the model re-issue the call
 * the cap refused. The session is read on the server (checkoutLinkStatus),
 * which only answers for sessions a chat link created and never hands back
 * anything about the buyer. While the webhook has not landed, the client polls
 * /api/upgrade/status, which answers a single boolean.
 *
 * A session id that is not a paid chat-link session has nothing to show here
 * and goes to /upgrade/expired.
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  const c = upgradeCopy(upgradeLocale((await headers()).get('accept-language')));
  return {
    title: c.doneMetaTitle,
    robots: { index: false, follow: false },
    // The session id is in this URL. Links out of the page must not carry it.
    referrer: 'no-referrer',
  };
}

export default async function UpgradeDonePage({ searchParams }) {
  const { session_id: raw } = (await searchParams) ?? {};
  const sessionId = checkoutSessionIdOrNull(raw);
  if (!sessionId) redirect('/upgrade/expired');

  const status = await checkoutLinkStatus(sessionId);
  if (status === 'unknown' || status === 'unpaid') redirect('/upgrade/expired');

  const c = upgradeCopy(upgradeLocale((await headers()).get('accept-language')));

  if (status === 'active') {
    return (
      <UpgradeShell tone="good" title={c.activeTitle} body={c.activeBody}>
        <a className="btn btn-secondary" href="/dashboard">{c.signIn}</a>
      </UpgradeShell>
    );
  }

  return (
    <ActivationStatus
      sessionId={sessionId}
      copy={{
        activeTitle: c.activeTitle,
        activeBody: c.activeBody,
        activatingTitle: c.activatingTitle,
        activatingBody: c.activatingBody,
        slowBody: c.slowBody,
        signIn: c.signIn,
      }}
    />
  );
}
