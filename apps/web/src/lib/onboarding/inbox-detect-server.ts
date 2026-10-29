/**
 * Server half of the onboarding inbox detection (see inbox-detect.ts).
 * Server only: autodiscover.ts reaches node:dns through host-guard.ts.
 * The resolvers are injected, so the tests never touch the network.
 */
import {
  autodiscoverMailSettings,
  isMicrosoft365Mx,
  isPublicMailDomain,
  normalizeDomain,
  type AutodiscoverDeps,
  type MxRecord,
} from '../email-providers/autodiscover.ts';
import { detectFromTable, type InboxDetection, type InboxKind } from './inbox-detect.ts';

/** Preset ids with a panel of their own, as found through DNS on a custom domain. */
const KIND_BY_PRESET: Record<string, InboxKind> = {
  icloud: 'icloud',
  yahoo: 'yahoo',
  aol: 'aol',
  gmx: 'gmx',
  'web-de': 'web_de',
  fastmail: 'fastmail',
  zoho: 'zoho',
  yandex: 'yandex',
};

/**
 * Never throws: a resolver that fails is a resolver that found nothing, and
 * the answer is then `imap` with no settings (the manual server form).
 */
export async function detectInboxDomain(rawDomain: string, deps: AutodiscoverDeps): Promise<InboxDetection> {
  const domain = normalizeDomain(rawDomain);
  const none: InboxDetection = { kind: 'imap', label: null, source: 'none', settings: null, customDomain: true };
  if (!isPublicMailDomain(domain)) return none;

  const table = detectFromTable(domain);
  if (table) return table;

  // One MX lookup, shared with autodiscover below.
  let mxPromise: Promise<MxRecord[]> | null = null;
  const resolveMx = (name: string): Promise<MxRecord[]> => {
    if (name !== domain) return deps.resolveMx(name);
    if (!mxPromise) mxPromise = Promise.resolve().then(() => deps.resolveMx(name)).catch(() => [] as MxRecord[]);
    return mxPromise;
  };

  const mx = await resolveMx(domain);
  if (Array.isArray(mx) && mx.some((record) => isMicrosoft365Mx(record?.exchange))) {
    return { kind: 'microsoft365', label: 'Microsoft 365', source: 'mx', settings: null, customDomain: true };
  }

  let found: Awaited<ReturnType<typeof autodiscoverMailSettings>> = null;
  try {
    found = await autodiscoverMailSettings(domain, { ...deps, resolveMx });
  } catch {
    found = null;
  }
  if (!found) return none;

  const { source, ...settings } = found;
  if (settings.provider === 'gmail') {
    return { kind: 'google_workspace', label: 'Google Workspace', source, settings, customDomain: true };
  }
  return { kind: KIND_BY_PRESET[settings.provider] ?? 'imap', label: settings.label || null, source, settings, customDomain: true };
}
