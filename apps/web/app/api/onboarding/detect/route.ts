import { NextRequest, NextResponse } from 'next/server';
import { Resolver } from 'node:dns/promises';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/rate-limit';
import { isPublicMailDomain, normalizeDomain, type MxRecord, type SrvRecord } from '@/lib/email-providers/autodiscover';
import { detectInboxDomain } from '@/lib/onboarding/inbox-detect-server';
import type { InboxDetection } from '@/lib/onboarding/inbox-detect';

/**
 * GET /api/onboarding/detect?domain=example.com
 *
 * The onboarding inbox step's provider detection (plan A3) for a domain the
 * browser's own table does not know: Microsoft 365 and Google Workspace from
 * the MX, then autodiscover (SRV, MX, Mozilla ISPDB, ISPDB on the MX base
 * domain for Strato, one.com, Rackspace). See src/lib/onboarding/inbox-detect*.
 *
 * 200 { detection: InboxDetection }. Takes a DOMAIN, never an address.
 * Signed in and rate limited for the same reason as /api/inboxes/autodiscover:
 * each call is several DNS queries and an HTTPS request on a name the caller
 * picks. Answers are public DNS facts, cached per instance (10 min, 1 min for
 * "nothing found") and privately in the browser.
 */
export const runtime = 'nodejs';

const DNS_TIMEOUT_MS = 2000;
const ISPDB_TIMEOUT_MS = 2500;
const TOTAL_TIMEOUT_MS = 4500;
const ISPDB_PREFIX = 'https://autoconfig.thunderbird.net/v1.1/';

const CACHE_TTL_HIT_MS = 10 * 60 * 1000;
const CACHE_TTL_MISS_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { expires: number; value: InboxDetection }>();

function cacheGet(domain: string): InboxDetection | null {
  const entry = cache.get(domain);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    cache.delete(domain);
    return null;
  }
  return entry.value;
}

function cacheSet(domain: string, value: InboxDetection): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const hit = value.source !== 'none';
  cache.set(domain, { expires: Date.now() + (hit ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS), value });
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

function respond(detection: InboxDetection): NextResponse {
  const hit = detection.source !== 'none';
  return NextResponse.json(
    { detection },
    { headers: { 'Cache-Control': `private, max-age=${hit ? 600 : 60}` } },
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized.', error_code: 'session_expired' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }

  const domain = normalizeDomain(request.nextUrl.searchParams.get('domain'));
  if (!isPublicMailDomain(domain)) {
    return NextResponse.json({ error: 'Not a valid mail domain.', error_code: 'domain_invalid' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const cached = cacheGet(domain);
  if (cached) return respond(cached);

  const limited = await checkRateLimit(`onboarding-detect:${user.id}`, 60, 10 * 60 * 1000);
  if (limited) {
    return NextResponse.json({ error: 'Too many lookups. Please try again shortly.', error_code: 'rate_limited' }, { status: 429, headers: { 'Cache-Control': 'no-store' } });
  }

  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  const fallback: InboxDetection = { kind: 'imap', label: null, source: 'none', settings: null, customDomain: true };
  const detection = await withTimeout(
    detectInboxDomain(domain, {
      resolveSrv: async (name) => (await resolver.resolveSrv(name)) as SrvRecord[],
      resolveMx: async (name) => (await resolver.resolveMx(name)) as MxRecord[],
      fetchIspdb: async (url) => {
        // Built in autodiscover.ts from a fixed origin; re-checked on the line
        // that opens the socket.
        if (!url.startsWith(ISPDB_PREFIX)) return null;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(ISPDB_TIMEOUT_MS),
          redirect: 'error',
          headers: { Accept: 'application/xml, text/xml' },
        });
        if (!response.ok) return null;
        return await response.text();
      },
    }),
    TOTAL_TIMEOUT_MS,
    fallback,
  );

  cacheSet(domain, detection);
  return respond(detection);
}
