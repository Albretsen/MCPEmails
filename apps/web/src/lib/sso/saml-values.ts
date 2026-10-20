/**
 * The values a customer's identity provider needs from us, and the one value
 * we need from it.
 *
 * OURS. Supabase Auth is the SAML service provider, so the Entity ID, the
 * Assertion Consumer Service URL and our SP metadata all live on the Supabase
 * project host. They are derived from NEXT_PUBLIC_SUPABASE_URL so a self-host
 * or a staging project shows its own values. If the project ever moves to a
 * custom auth domain these change, and every customer has to reconfigure.
 *
 * THEIRS. The admin pastes Entra's "App Federation Metadata Url". Supabase
 * fetches it, not us, so this module only checks its shape: https, a
 * Microsoft sign-in host, and the federation metadata path. Anything else is
 * refused before it reaches the Management API.
 */

export interface SamlServiceProviderValues {
  entityId: string;
  acsUrl: string;
  metadataUrl: string;
}

export function samlServiceProviderValues(supabaseUrl: string | undefined): SamlServiceProviderValues | null {
  if (!supabaseUrl) return null;
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') return null;
  const origin = base.origin;
  const metadataUrl = `${origin}/auth/v1/sso/saml/metadata`;
  return { entityId: metadataUrl, acsUrl: `${origin}/auth/v1/sso/saml/acs`, metadataUrl };
}

/** Microsoft Entra sign-in hosts: global, US government, and China (21Vianet). */
const ENTRA_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoftonline.us',
  'login.partner.microsoftonline.cn',
]);

export type MetadataUrlCheck =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: 'invalid' | 'not_https' | 'not_entra' };

/**
 * Whether a pasted value is an Entra federation metadata URL. Returns the
 * normalised URL (no fragment) to pass to Supabase as `metadata_url`.
 */
export function checkEntraMetadataUrl(input: unknown): MetadataUrlCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid' };
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 2048) return { ok: false, reason: 'invalid' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username || url.password || url.port) return { ok: false, reason: 'invalid' };
  const host = url.hostname.toLowerCase();
  if (!ENTRA_HOSTS.has(host)) return { ok: false, reason: 'not_entra' };
  if (!/\/federationmetadata\/2007-06\/federationmetadata\.xml$/i.test(url.pathname)) {
    return { ok: false, reason: 'not_entra' };
  }
  url.hash = '';
  return { ok: true, url: url.toString(), host };
}
