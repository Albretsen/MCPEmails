import { NextRequest, NextResponse } from 'next/server';
import { Resolver } from 'node:dns/promises';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  autodiscoverMailSettings,
  isPublicMailDomain,
  normalizeDomain,
  type AutodiscoveredSettings,
  type MxRecord,
  type SrvRecord,
} from '@/lib/email-providers/autodiscover';

/**
 * dns/promises, so this handler must run on the Node runtime. Declared rather
 * than assumed: an edge runtime has no resolver at all and the failure would
 * be a build-time module error, not a bad answer.
 */
export const runtime = 'nodejs';

/**
 * Every lookup here is capped. The form runs this while the user is still
 * typing, so a domain with a black-holed nameserver must cost a second and
 * then be forgotten, not hold a function open for the resolver's default
 * retry schedule (5s per try, four tries).
 */
const DNS_TIMEOUT_MS = 2000;
const ISPDB_TIMEOUT_MS = 2500;
/** Ceiling on the whole thing, so no single request can outlive the typing. */
const TOTAL_TIMEOUT_MS = 4000;

/**
 * Per-domain memo, in the function's own memory.
 *
 * The client debounces, but a person types their address, tabs away, tabs
 * back, corrects a character and tabs away again, and each of those is another
 * request for the same domain. Without this, one address is four sets of DNS
 * queries. It is per-instance and therefore not a real cache; it does not need
 * to be, because the thing it is protecting against is one user repeating
 * themselves within a minute or two.
 *
 * Negative answers are cached for a much shorter time than positive ones: a
 * domain that has no mail records today may be one the user is in the middle
 * of setting up, and a ten-minute memory of "nothing here" would outlast the
 * fix.
 */
const CACHE_TTL_HIT_MS = 10 * 60 * 1000;
const CACHE_TTL_MISS_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { expires: number; value: AutodiscoveredSettings | null }>();

function cacheGet(domain: string): { value: AutodiscoveredSettings | null } | null {
  const entry = cache.get(domain);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    cache.delete(domain);
    return null;
  }
  return { value: entry.value };
}

function cacheSet(domain: string, value: AutodiscoveredSettings | null): void {
  // Plain FIFO eviction on a Map, which preserves insertion order. There is no
  // hit-rate case worth an LRU here: the working set is one domain per user
  // per minute.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(domain, { expires: Date.now() + (value ? CACHE_TTL_HIT_MS : CACHE_TTL_MISS_MS), value });
}

/** Resolve, but never for longer than `ms`, and never by throwing. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

/**
 * A resolver with its own short budget, rather than the process-wide default.
 * `tries: 1` on top of the timeout: a retry against a nameserver that did not
 * answer the first time is time spent on a domain that is not going to answer.
 */
function makeResolver(): Resolver {
  return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
}

/**
 * POST /api/inboxes/autodiscover
 *
 * Body: { domain: "example.com" }
 * 200:  { found: true, settings: {...} } | { found: false }
 *
 * Takes a DOMAIN, never an address. The local part is of no use to any lookup
 * here, and not sending it means a mailbox name never reaches this log line.
 *
 * Authenticated and rate limited, both because of what it is rather than what
 * it returns: an unauthenticated endpoint that performs four DNS queries and
 * an outbound HTTPS request per call, on a name the caller chooses, is a
 * traffic amplifier pointed at whoever the caller names. It answers nothing a
 * signed-in user could not learn with `dig`, so the point of the auth check is
 * to make the amplification attributable, and of the rate limit to make it
 * small.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });

  // 60 lookups per 10 minutes per user. A person connecting one mailbox makes
  // a handful even with a lot of retyping, and the client memoises the answer
  // for the address it is looking at.
  const limited = await checkRateLimit(`autodiscover:${user.id}`, 60, 10 * 60 * 1000);
  if (limited) {
    return NextResponse.json(
      { error: 'Too many lookups. Please try again shortly.', error_code: 'rate_limited' },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON.', error_code: 'bad_request' }, { status: 400 });
  }

  const domain = normalizeDomain(body.domain);
  // Refused before any lookup: this is the check that keeps the resolver
  // pointed at the public internet. See isPublicMailDomain for what it rules
  // out and why.
  if (!isPublicMailDomain(domain)) {
    return NextResponse.json({ error: 'Not a valid mail domain.', error_code: 'domain_invalid' }, { status: 400 });
  }

  const cached = cacheGet(domain);
  if (cached) {
    return NextResponse.json(
      cached.value ? { found: true, settings: cached.value } : { found: false },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const resolver = makeResolver();

  const settings = await withTimeout(
    autodiscoverMailSettings(domain, {
      resolveSrv: async (name) => (await resolver.resolveSrv(name)) as SrvRecord[],
      resolveMx: async (name) => (await resolver.resolveMx(name)) as MxRecord[],
      fetchIspdb: async (url) => {
        // The URL is built in autodiscover.ts from a fixed origin plus the
        // percent-encoded domain, and is re-checked here rather than trusted,
        // because this is the line that actually opens the socket.
        if (!url.startsWith('https://autoconfig.thunderbird.net/v1.1/')) return null;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(ISPDB_TIMEOUT_MS),
          // No credentials, no cookies, and do not follow a redirect off the
          // host we allowed above.
          redirect: 'error',
          headers: { Accept: 'application/xml, text/xml' },
        });
        // A 404 is the normal answer: the ISPDB only lists provider-owned
        // domains, so every custom domain misses.
        if (!response.ok) return null;
        return await response.text();
      },
    }),
    TOTAL_TIMEOUT_MS,
    null
  );

  cacheSet(domain, settings);

  return NextResponse.json(
    settings ? { found: true, settings } : { found: false },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
