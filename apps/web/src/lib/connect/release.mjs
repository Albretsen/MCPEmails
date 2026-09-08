import { PROVIDERS, getProvider } from './providers.mjs';

/**
 * Staged release of the provider landing pages.
 *
 * The original schedule put these 106 pages out in ten weekly waves, from
 * 2026-08-31 to 2026-11-02, for three stated reasons. Eight days of production
 * data settled all three, so the schedule is now collapsed into three dates.
 *
 *  1. Crawl budget. Wrong at this size. Crawl budget binds on sites in the tens
 *     of thousands of URLs; this domain went from ~42 to ~150. Unpublished
 *     pages were not saving a budget that was ever under pressure.
 *  2. A learning loop, to see whether the format ranks before committing the
 *     other 90 pages to it. This one worked, and it answered fast. Wave 1
 *     carried five genuinely new pages (imap, gmx, ionos, aol, migadu). Within
 *     eight days gmx, ionos and imap had produced 9 attributed signups, 6 of
 *     them organic Google, which is 19% of every signup ever attributed to a
 *     /connect page. The format ranks in days, not months. There is nothing
 *     further to learn by waiting, and each week of waiting costs the tail of
 *     the set its own indexing lead time on top.
 *  3. Blast radius, so a systematic error surfaces on ten pages rather than
 *     all of them. Still valid, but it attaches to specific pages rather than
 *     to a calendar. The pages with weak sourcing are held below by name.
 *
 * Wave numbers are kept as cohort identifiers even where several now share a
 * date: they record which batch a page was researched and generated in, which
 * is what a blast-radius diagnosis needs. They are no longer a queue.
 *
 * A wave is released when its date has passed. `null` is a deliberate hold: the
 * pages stay private until a human changes this file, because what gates them
 * is a review that has not happened, not a date that has not arrived.
 *
 * Every route on this site renders per request (Set-Cookie from the experiment
 * assignment forces it), so a wave goes live on its date with no deploy. If
 * these pages are ever made statically generated, this gate freezes at build
 * time and will need a revalidate window to match.
 */
export const RELEASE_WAVES = {
  1: '2026-08-31',
  2: '2026-09-07',
  // Everything the product can actually connect: hosting, cPanel, privacy,
  // regional and ISP mailboxes.
  3: '2026-09-08',
  4: '2026-09-08',
  5: '2026-09-08',
  6: '2026-09-08',
  7: '2026-09-08',
  // Self-hosted stacks, then the `blocked` set (Outlook, Office365, Proton,
  // Tutanota, Hey), whose honest answer is "no". A week behind the rest so the
  // supported pages are the ones indexed first.
  8: '2026-09-15',
  9: '2026-09-15',
  // HELD, not scheduled. These seven need a human spot-check first: SFR and
  // StartMail are sourced more weakly than the rest of the set, and Rogers has
  // app-password availability contradicted between two live vendor pages. Set
  // a date here once someone has read them.
  10: null,
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
  // No date means either a deliberate hold (the wave is present and null) or a
  // data error (the wave is unknown). Both stay private, so the failure mode is
  // a missing page rather than a surprise one.
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

/** True when a wave is deliberately parked with no date, rather than queued. */
export function isHeld(wave) {
  return Object.hasOwn(RELEASE_WAVES, wave) && RELEASE_WAVES[wave] === null;
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
      held: isHeld(wave),
      // Asked through isReleased so a held wave and a released one can never
      // disagree between this report and what the routes actually serve.
      released: isReleased({ wave: Number(wave) }, now),
      count: slugs.length,
      slugs: slugs.sort(),
    }))
    .sort((a, b) => a.wave - b.wave);
}
