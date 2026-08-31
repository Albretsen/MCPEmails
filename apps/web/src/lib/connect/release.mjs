import { PROVIDERS, getProvider } from './providers.mjs';

/**
 * Staged release of the provider landing pages.
 *
 * 100 of these 106 pages are new to production, on a site that has roughly 42
 * indexed URLs. Publishing them in one go would triple the site overnight.
 *
 * The reason for staging is NOT that volume is penalised on its own; it is not,
 * and treating a slow rollout as protection against a spam judgement would be
 * superstition. The reasons that do hold:
 *
 *  1. Crawl budget. A domain with this backlink profile does not get 106 new
 *     URLs crawled promptly however they are published, so releasing faster
 *     than they can be crawled buys nothing.
 *  2. A learning loop. Wave 1 tells us whether the format ranks before the
 *     other 90 pages are committed to it.
 *  3. Blast radius. A systematic error in one cohort (a wrong ISP status, a
 *     stale hostname) surfaces on ten pages rather than all of them.
 *
 * A wave is released when its date has passed. Every route on this site renders
 * per request, so a wave goes live on its date with no deploy. If these pages
 * are ever made statically generated, this gate freezes at build time and will
 * need a revalidate window to match.
 */
export const RELEASE_WAVES = {
  1: '2026-08-31',
  2: '2026-09-07',
  3: '2026-09-14',
  4: '2026-09-21',
  5: '2026-09-28',
  6: '2026-10-05',
  7: '2026-10-12',
  8: '2026-10-19',
  9: '2026-10-26',
  10: '2026-11-02',
};

/**
 * Escape hatch for previewing the whole set: unreleased pages render, and are
 * still kept out of the sitemap and the hub. Set CONNECT_RELEASE_ALL=1 in a
 * preview environment. It must never be set in production, or the schedule is
 * decorative.
 */
function releaseAll() {
  return process.env.CONNECT_RELEASE_ALL === '1';
}

export function waveReleaseDate(wave) {
  return RELEASE_WAVES[wave] ?? null;
}

export function isReleased(provider, now = new Date()) {
  if (!provider) return false;
  const date = RELEASE_WAVES[provider.wave];
  // A provider with no wave is a data error. Treat it as unreleased rather than
  // letting it leak out, so the failure is a missing page and not a surprise one.
  if (!date) return false;
  return now >= new Date(`${date}T00:00:00.000Z`);
}

/** Released providers. This is the list every public surface must be built from. */
export function releasedProviders(now = new Date()) {
  return PROVIDERS.filter((p) => isReleased(p, now));
}

/** True when the page may render at all, honouring the preview override. */
export function isViewable(provider, now = new Date()) {
  return isReleased(provider, now) || releaseAll();
}

/** Locale/provider pairs for released providers only. */
export function releasedProviderParams(now = new Date()) {
  const out = [];
  for (const p of PROVIDERS) {
    if (!isReleased(p, now) && !releaseAll()) continue;
    for (const locale of p.locales) out.push({ locale, provider: p.slug });
  }
  return out;
}

/**
 * Siblings to link from a provider page, restricted to what is already public.
 *
 * Linking an unreleased page would put a 404 in front of both readers and
 * crawlers, and a page that links into a wave that does not exist yet is worse
 * than a page with fewer links. Same category first, rotating so that a large
 * silo does not point every page at the same six.
 *
 * The list is then topped up from every other released provider, because a
 * silo can be smaller than `limit` and briefly is for most of the rollout:
 * `generic` has exactly one member, so /connect/imap would otherwise carry no
 * outbound links at all, and it is the highest-priority page here. Internal
 * links are the whole reason this set is crawlable, so running out of siblings
 * has to degrade into a wider net rather than into nothing.
 */
export function relatedProviders(slug, limit = 6, now = new Date()) {
  const self = getProvider(slug);
  if (!self) return [];
  const pool = releasedProviders(now).filter((p) => p.slug !== slug);

  // Rotate by slug so each page in a category seeds a different slice.
  const rotate = (list) => {
    const start = Math.max(0, list.findIndex((p) => p.slug > slug));
    return [...list.slice(start), ...list.slice(0, start)];
  };

  const out = rotate(pool.filter((p) => p.category === self.category)).slice(0, limit);
  if (out.length < limit) {
    const taken = new Set(out.map((p) => p.slug));
    // Generic IMAP first when it is not already in: it is the page that answers
    // "my provider is not listed", which is the likeliest next question.
    const generic = pool.find((p) => p.slug === 'imap');
    if (generic && !taken.has('imap')) {
      out.push(generic);
      taken.add('imap');
    }
    for (const p of rotate(pool.filter((x) => x.category !== self.category))) {
      if (out.length >= limit) break;
      if (!taken.has(p.slug)) {
        out.push(p);
        taken.add(p.slug);
      }
    }
  }
  return out;
}

/** Rollout progress, for the release-status script and for sanity checks. */
export function releaseStatus(now = new Date()) {
  const byWave = {};
  for (const p of PROVIDERS) {
    (byWave[p.wave] ??= []).push(p.slug);
  }
  return Object.entries(byWave)
    .map(([wave, slugs]) => ({
      wave: Number(wave),
      date: RELEASE_WAVES[wave] ?? null,
      released: now >= new Date(`${RELEASE_WAVES[wave]}T00:00:00.000Z`),
      count: slugs.length,
      slugs: slugs.sort(),
    }))
    .sort((a, b) => a.wave - b.wave);
}
