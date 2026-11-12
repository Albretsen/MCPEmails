import type { ReactNode } from 'react';
import HomeLabPicker from './Picker';
import { HOME_LAB_VARIANTS } from './registry.mjs';

/**
 * Homepage Lab picker (staging only). Reached through the `home-lab-entry`
 * alias, which is this file on staging builds and `off.ts` everywhere else.
 * It imports only registry.mjs (the picker labels), never a variant folder:
 * importing even a variant's meta.mjs from here put every variant's CSS on
 * the home page. Each variant
 * renders from its own route (`app/[locale]/home-lab/vNN`) so a page ships
 * only its own CSS. The proxy rewrites `/?home=vNN` to that route.
 */

export type HomeLabProps = {
  stripePrices: unknown;
  eurEnabled: boolean;
  businessSeat: unknown;
  faqItems: { q: string; a: string }[];
  locale: string;
};


export async function renderHomeLab({ current, id }: { current: ReactNode; id: string }): Promise<ReactNode> {
  return (
    <>
      {current}
      <HomeLabPicker variants={HOME_LAB_VARIANTS} current={id} />
    </>
  );
}
