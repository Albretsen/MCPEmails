'use client';

import { useState, useEffect } from 'react';
import { useTweaks, TweakSection, TweakRadio, TweakToggle, TweaksPanel } from '../tweaks-panel';
import {
  Nav, Hero, Trusted, Features, DashboardPreview, HowItWorks, Examples, Quote, Pricing, Faq, Footer
} from './Sections';
import { DemoVideo, DEMO_VIDEO_AVAILABLE } from './DemoVideo';

const TWEAK_DEFAULTS = {
  heroVariant: 'pipe',
  dark: false,
};

/**
 * @param {{ stripePrices?: import('@/lib/stripe/getPrices').StripePricesMap }} props
 */
export default function HomeClient({ stripePrices }) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Apply dark mode (also persisted so other pages match)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', t.dark ? 'dark' : 'light');
    try {
      localStorage.setItem('mcpe-theme', t.dark ? 'dark' : 'light');
    } catch (e) {}
  }, [t.dark]);

  // Read initial dark state from localStorage on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem('mcpe-theme');
      if (saved === 'dark' && !t.dark) setTweak('dark', true);
      if (saved === 'light' && t.dark) setTweak('dark', false);
    } catch (e) {}
  }, []);

  const onSignIn = () => {};
  const onGetStarted = () => {};

  return (
    <div data-screen-label="Marketing / Home">
      <Nav onSignIn={onSignIn} onGetStarted={onGetStarted} />
      <main>
        <Hero variant={t.heroVariant} onGetStarted={onGetStarted} />
        <Trusted />
        <Features />
        {/* The demo recording replaces the invented dashboard mockup. Until the
            video files land under public/demo/, keep the old section rather
            than shipping an empty player. See DemoVideo.jsx. */}
        {DEMO_VIDEO_AVAILABLE ? <DemoVideo /> : <DashboardPreview />}
        <HowItWorks />
        <Examples />
        <Quote />
        <Pricing onGetStarted={onGetStarted} stripePrices={stripePrices} />
        <Faq />
      </main>
      <Footer />

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
