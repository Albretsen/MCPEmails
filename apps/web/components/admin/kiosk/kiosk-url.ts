/**
 * Every link on the kiosk is built here.
 *
 * The board's state is entirely in its URL: which view, which window, which
 * tile has been opened for detail, and (only when the cookie is not working)
 * the bootstrap token. That is what makes a refresh, a deploy reload, the
 * five-minute `router.refresh()` and a walk-past all land somewhere defined.
 *
 * It is also four parameters that every link has to carry, and the failure mode
 * of assembling them at each call site is silent: a tile link that forgets
 * `days` sends the operator from a 90 day board to a 28 day detail panel
 * showing a different number for the metric they just tapped. So the assembly
 * lives in one pure function that both server tiles and client controls call.
 *
 * DEFAULTS ARE OMITTED, not spelled out. The Pi's autostart line points at the
 * bare `/admin/growth/kiosk`, and the idle timer returns there, so the default
 * view at the default window must be reachable without a query string being
 * spelled correctly.
 */

import { DEFAULT_KIOSK_VIEW, type KioskViewId } from './shared';
import { DEFAULT_KIOSK_WINDOW_DAYS } from './windows';

export const KIOSK_PATH = '/admin/growth/kiosk';

export type KioskLocation = {
  view?: KioskViewId;
  days?: number;
  /** The `?k=` bootstrap token, forwarded only when the request carried one. */
  token?: string;
  /** The metric whose full-screen panel is open, if any. */
  detail?: string | null;
};

export function kioskHref({ view, days, token, detail }: KioskLocation): string {
  const params = new URLSearchParams();
  if (view && view !== DEFAULT_KIOSK_VIEW) params.set('view', view);
  if (days && days !== DEFAULT_KIOSK_WINDOW_DAYS) params.set('days', String(days));
  if (detail) params.set('detail', detail);
  // Last, so the one parameter nobody should be reading over a shoulder is not
  // the one in the middle of the address bar.
  if (token) params.set('k', token);
  const query = params.toString();
  return query ? `${KIOSK_PATH}?${query}` : KIOSK_PATH;
}
