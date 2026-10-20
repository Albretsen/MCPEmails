/**
 * The only code that talks to the Supabase Management API: create, update and
 * delete the per-customer SAML provider.
 *
 * SECRET. The token is SUPABASE_MANAGEMENT_API_TOKEN, a server-only env var on
 * Vercel (never NEXT_PUBLIC_). It should be a token with only the
 * `auth_config_write` permission, but even then it can rewrite all of this
 * project's Auth settings, so it is read here and nowhere else, never logged,
 * never echoed in an error, and never sent to the browser. Callers get typed
 * errors that carry an HTTP status and a short reason, not response bodies.
 *
 * PROJECT. The project ref is the first label of NEXT_PUBLIC_SUPABASE_URL's
 * host (`<ref>.supabase.co`), or SUPABASE_PROJECT_REF when set (self-host or a
 * custom domain).
 *
 * ATTRIBUTES. Only email is required. Entra sends it as the long
 * `.../claims/emailaddress` URI by default; `name` maps Entra's display-name
 * claim so the new public.users row gets a real name. The claim names are
 * Entra defaults and still need a live-tenant check (T9).
 */

if (typeof window !== 'undefined') {
  throw new Error('lib/sso/management-api is server-only');
}

const API_BASE = 'https://api.supabase.com';
const TIMEOUT_MS = 15_000;

export const SSO_MANAGEMENT_TOKEN_ENV = 'SUPABASE_MANAGEMENT_API_TOKEN';

const ATTRIBUTE_MAPPING = {
  keys: {
    email: {
      names: [
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
      ],
    },
    name: { name: 'http://schemas.microsoft.com/identity/claims/displayname' },
  },
} as const;

const NAME_ID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

export type SsoManagementFailure =
  /** No token or no project ref in this environment. */
  | 'not_configured'
  /** Supabase refused the metadata (unreachable URL, bad XML, ...). */
  | 'metadata_rejected'
  /** The provider id we hold no longer exists in Supabase. */
  | 'provider_missing'
  /** Token rejected or lacks the scope. Owner action needed. */
  | 'unauthorized'
  /** Timeout, network error, 5xx or an answer we cannot read. */
  | 'unavailable';

export class SsoManagementError extends Error {
  readonly reason: SsoManagementFailure;
  readonly status: number | null;
  constructor(reason: SsoManagementFailure, status: number | null) {
    super(`Supabase Management API: ${reason}${status === null ? '' : ` (HTTP ${status})`}`);
    this.name = 'SsoManagementError';
    this.reason = reason;
    this.status = status;
  }
}

interface ManagementConfig {
  token: string;
  projectRef: string;
}

/** Reads the env. Exported for tests and for the "is this set up" flag. */
export function managementConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ManagementConfig | null {
  const token = env[SSO_MANAGEMENT_TOKEN_ENV]?.trim();
  if (!token) return null;
  let projectRef = env.SUPABASE_PROJECT_REF?.trim() ?? '';
  if (!projectRef) {
    try {
      const host = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '').hostname;
      if (host.endsWith('.supabase.co')) projectRef = host.split('.')[0] ?? '';
    } catch {
      projectRef = '';
    }
  }
  if (!/^[a-z0-9]{20}$/.test(projectRef)) return null;
  return { token, projectRef };
}

export function isSsoManagementConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return managementConfigFromEnv(env) !== null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

async function call(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const config = managementConfigFromEnv(env);
  if (!config) throw new SsoManagementError('not_configured', null);

  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}/v1/projects/${config.projectRef}/config/auth/sso/providers${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new SsoManagementError('unavailable', null);
  }

  if (res.status === 401 || res.status === 403) throw new SsoManagementError('unauthorized', res.status);
  if (res.status === 404) throw new SsoManagementError('provider_missing', res.status);
  if (res.status === 400 || res.status === 422) throw new SsoManagementError('metadata_rejected', res.status);
  if (!res.ok) throw new SsoManagementError('unavailable', res.status);
  if (method === 'DELETE') return null;
  try {
    return await res.json();
  } catch {
    throw new SsoManagementError('unavailable', res.status);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function providerIdFrom(body: unknown, status: number | null): string {
  const id = (body as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new SsoManagementError('unavailable', status);
  return id.toLowerCase();
}

export interface SsoManagementOptions {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

/**
 * Creates a SAML provider from a metadata URL. Returns its id. No `domains`
 * are sent: our verified sso_domains table routes sign-ins, not Supabase.
 */
export async function createSamlProvider(metadataUrl: string, opts: SsoManagementOptions = {}): Promise<string> {
  const body = await call(
    'POST',
    '',
    { type: 'saml', metadata_url: metadataUrl, attribute_mapping: ATTRIBUTE_MAPPING, name_id_format: NAME_ID_FORMAT },
    opts.fetchImpl ?? fetch,
    opts.env ?? process.env,
  );
  return providerIdFrom(body, 201);
}

/** Points an existing provider at a new metadata URL (Entra certificate roll, new app). */
export async function updateSamlProvider(
  providerId: string,
  metadataUrl: string,
  opts: SsoManagementOptions = {},
): Promise<void> {
  if (!UUID.test(providerId)) throw new SsoManagementError('provider_missing', null);
  await call(
    'PUT',
    `/${providerId}`,
    { metadata_url: metadataUrl, attribute_mapping: ATTRIBUTE_MAPPING, name_id_format: NAME_ID_FORMAT },
    opts.fetchImpl ?? fetch,
    opts.env ?? process.env,
  );
}

/** Deletes a provider. A provider that is already gone counts as deleted. */
export async function deleteSamlProvider(providerId: string, opts: SsoManagementOptions = {}): Promise<void> {
  if (!UUID.test(providerId)) return;
  try {
    await call('DELETE', `/${providerId}`, undefined, opts.fetchImpl ?? fetch, opts.env ?? process.env);
  } catch (err) {
    if (err instanceof SsoManagementError && err.reason === 'provider_missing') return;
    throw err;
  }
}
