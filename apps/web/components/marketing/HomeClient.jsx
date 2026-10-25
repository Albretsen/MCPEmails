'use client';

import { useEffect } from 'react';
import { useTweaks, TweakSection, TweakRadio, TweakToggle, TweaksPanel } from '../tweaks-panel';
import {
  Nav, Hero, Trusted, WhatIs, Features, FeaturedReview, DashboardPreview, HowItWorks, Examples, Quote, Reviews,
  Pricing, Faq, Footer
} from './Sections';
import { ReferralBanner } from './ReferralBanner';
import { useDisplayCurrency } from './useDisplayCurrency';

const TWEAK_DEFAULTS = {
  heroVariant: 'pipe',
  dark: false,
};

/**
 * @param {{
 *   stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap,
 *   eurEnabled?: boolean,
 * }} props
 */
export default function HomeClient({ stripePrices, eurEnabled = false }) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  // 'eur' only for an EU visitor while STRIPE_EUR_PRICES is on; see the hook.
  const currency = useDisplayCurrency(eurEnabled);

  // Apply dark mode (also persisted so other pages match)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', t.dark ? 'dark' : 'light');
    try {
      localStorage.setItem('mcpe-theme', t.dark ? 'dark' : 'light');
    } catch {}
  }, [t.dark]);

  // Read initial dark state from localStorage on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('mcpe-theme');
      if (saved === 'dark' && !t.dark) setTweak('dark', true);
      if (saved === 'light' && t.dark) setTweak('dark', false);
    } catch {}
  // Mount-only: it seeds the theme from localStorage. Listing t.dark/setTweak would make it
  // fight the effect above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSignIn = () => {};
  const onGetStarted = () => {};

  return (
    <div data-screen-label="Marketing / Home">
      <Nav onSignIn={onSignIn} onGetStarted={onGetStarted} />
      <main>
        <Hero variant={t.heroVariant} onGetStarted={onGetStarted} />
        <FeaturedReview />
        <Trusted />
        <WhatIs />
        <Features />
        <DashboardPreview />
        <HowItWorks />
        <Examples />
        <Quote />
        <Reviews />
        <Pricing onGetStarted={onGetStarted} stripePrices={stripePrices} currency={currency} />
        <Faq currency={currency} />
      </main>
      <Footer />
      <ReferralBanner />

      <TweaksPanel>
        <TweakSection label="Hero" />
        <TweakRadio
          label="Visual"
          value={t.heroVariant}
          options={[
            { value: 'pipe', label: 'Pipe diagram' },
            { value: 'endpoint', label: 'MCP endpoint' },
            { value: 'terminal', label: 'Live terminal' },
          ]}
          onChange={(v) => setTweak('heroVariant', v)}
        />
        <TweakSection label="Theme" />
        <TweakToggle
          label="Dark mode"
          value={t.dark}
          onChange={(v) => setTweak('dark', v)}
        />
      </TweaksPanel>
    </div>
  );
}
