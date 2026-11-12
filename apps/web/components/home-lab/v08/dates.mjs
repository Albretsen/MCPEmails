/**
 * "Last updated" dates for v08's section headers.
 *
 * Each date was read on 2026-11-12 with
 *   git log -1 --format=%cs -- <paths>
 * over the files the section describes, and is stored here as a constant
 * (the page never runs git at request time). `paths` records exactly what was
 * asked, so anyone can re-run the command and refresh a date.
 */
export const UPDATED = {
  hero: { date: '2026-11-02', paths: ['apps/mcp-app/src'] },
  quotes: { date: '2026-09-16', paths: ['apps/web/components/marketing/reviews.mjs'] },
  spec: {
    date: '2026-11-11',
    paths: ['every path of the seven spec groups below, in one git log call'],
  },
  specWhat: { date: '2026-11-10', paths: ['apps/web/messages/en/home.json'] },
  specProviders: {
    date: '2026-11-11',
    paths: [
      'apps/web/src/lib/email-providers',
      'supabase/functions/mcp-server/imap-client.ts',
      'supabase/functions/mcp-server/outlook-graph.ts',
    ],
  },
  specClients: { date: '2026-11-11', paths: ['apps/web/src/lib/clients', 'apps/web/app/api/oauth'] },
  specData: {
    date: '2026-11-04',
    paths: [
      'supabase/functions/mcp-server/storage-crypto.ts',
      'apps/web/src/lib/crypto.ts',
      'apps/web/app/[locale]/privacy',
      'apps/web/app/api/oauth/revoke',
    ],
  },
  specSending: {
    date: '2026-11-11',
    paths: [
      'apps/web/app/api/approvals',
      'supabase/functions/mcp-server/mcp-app-approvals.ts',
      'apps/mcp-app/src',
      'supabase/functions/mcp-server/smtp-relay.ts',
    ],
  },
  specSetup: { date: '2026-11-10', paths: ['apps/web/app/[locale]/docs', 'apps/web/app/[locale]/connect'] },
  specPlans: { date: '2026-11-11', paths: ['apps/web/src/lib/stripe/plans.ts'] },
  security: {
    date: '2026-11-03',
    paths: [
      'apps/web/app/[locale]/security',
      'supabase/functions/mcp-server/storage-crypto.ts',
      'apps/web/src/lib/crypto.ts',
      'apps/web/app/api/oauth/revoke',
    ],
  },
  letter: { date: '2026-11-03', paths: ['apps/web/messages/en/about.json'] },
  pricing: {
    date: '2026-11-11',
    paths: ['apps/web/src/lib/stripe/plans.ts', 'apps/web/src/lib/billing/business-seat-copy.ts', 'apps/web/src/lib/billing/business-seat-copy'],
  },
  faq: { date: '2026-11-10', paths: ['apps/web/messages/en/home.json'] },
  start: { date: '2026-11-10', paths: ['apps/web/app/[locale]/connect'] },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-10" -> "10 Nov 2026" (no time zone maths: a git %cs date is a calendar date). */
export function humanDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
