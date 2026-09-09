/**
 * The header both user pages wear, and the URL arithmetic underneath it.
 *
 * WHY A SHARED HEADER. /admin/growth/users is a view of the growth board, not
 * a separate product: it answers "who, exactly" where the board answers "how
 * many", and the two are read in the same sitting. It therefore keeps the
 * board's chrome -- the same wordmark, the same section links, the same window
 * switch -- so moving between them is a change of question rather than a change
 * of application.
 *
 * EVERY CONTROL ON THESE PAGES IS A LINK OR A GET FORM. No 'use client', no
 * fetch from the browser, no Server Action. Sort, segment, search and page are
 * all in the query string, which makes every state of this table addressable,
 * bookmarkable, and shareable into a message -- and means the back button does
 * what a table's back button should do. It is also the pattern the experiments
 * page already uses, for the harder reason that Server Actions failed their
 * action-ID lookup in production on this app.
 */

import Link from 'next/link';

export const USERS_PATH = '/admin/growth/users';

/** Query state for the directory. Everything the table can be looked at as. */
export type UsersQuery = {
  segment: string;
  q: string;
  sort: string;
  dir: 'asc' | 'desc';
  page: number;
  size: number;
};

export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZES = [25, 50, 100, 250] as const;

/**
 * A URL for the same table in a different state.
 *
 * Defaults are omitted from the string rather than written out, so the plain
 * `/admin/growth/users` stays the canonical address of the default view and two
 * links to the same table cannot look different.
 */
export function usersHref(query: UsersQuery, overrides: Partial<UsersQuery> = {}): string {
  const next = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.segment && next.segment !== 'all') params.set('segment', next.segment);
  if (next.q.trim()) params.set('q', next.q.trim());
  if (next.sort && next.sort !== 'signed_up') params.set('sort', next.sort);
  if (next.dir !== 'desc') params.set('dir', next.dir);
  if (next.size !== DEFAULT_PAGE_SIZE) params.set('size', String(next.size));
  if (next.page > 1) params.set('page', String(next.page));
  const search = params.toString();
  return search ? `${USERS_PATH}?${search}` : USERS_PATH;
}

/** Reads the query string into a fully defaulted state. Never throws. */
export function readQuery(params: Record<string, string | string[] | undefined>): UsersQuery {
  const one = (key: string): string => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };
  const size = Number.parseInt(one('size'), 10);
  const page = Number.parseInt(one('page'), 10);
  return {
    segment: one('segment') || 'all',
    q: one('q'),
    sort: one('sort') || 'signed_up',
    dir: one('dir') === 'asc' ? 'asc' : 'desc',
    page: Number.isFinite(page) && page > 0 ? page : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

export function Chrome({ trail, tools }: { trail: React.ReactNode; tools?: React.ReactNode }) {
  return (
    <header className="gb-head">
      <h1 className="gb-wordmark">
        <Link href="/admin/growth">Growth</Link>
      </h1>
      <nav className="gb-jump" aria-label="Breadcrumb">
        {trail}
      </nav>
      <div className="gb-tools">
        {tools}
        <a className="gb-link" href="/admin/growth">Board</a>
        <a className="gb-link" href="/admin/growth/kiosk">Kiosk</a>
        <a className="gb-link" href="/admin/growth/experiments">Experiments</a>
        <a className="gb-link" href="/admin/growth/dunning">Dunning</a>
        {/* A route handler rather than a Server Action, for the reason in the
            file header: the action-ID lookup failed on every submission in
            production. Refreshing drops the `growth:accounts` tag with the rest. */}
        <form action="/admin/growth/refresh" method="POST">
          <button type="submit">Refresh</button>
        </form>
      </div>
    </header>
  );
}
