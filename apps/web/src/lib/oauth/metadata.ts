/**
 * The one definition of this authorization server's discovery metadata.
 *
 * Two documents are served from it: RFC 8414
 * (`/.well-known/oauth-authorization-server`), which every MCP client reads,
 * and OpenID Connect Discovery (`/.well-known/openid-configuration`), which
 * only the ChatGPT plugin portal reads, and only to decide whether a Business
 * or Enterprise workspace may restrict this connector to its own email domain.
 *
 * They are built here together because the failure mode is drift: the OIDC
 * document is the one nobody looks at for months, so a token endpoint that
 * moved would be advertised correctly in one place and stale in the other,
 * and the client that believed the wrong one is the one that cannot connect.
 */

/** Scopes that authorize MCP tools. The user grants these on the consent screen. */
export const TOOL_SCOPES = [
  'read:email',
  'search:email',
  'send:email',
  'manage:folders',
  'delete:email',
  'manage:drafts',
  'manage:contacts',
  'schedule:email',
  'manage:automations',
] as const;

/**
 * Scopes that authorize IDENTITY claims and nothing else.
 *
 * They unlock `sub`, `email` and `email_verified` at the userinfo endpoint.
 * They grant no mailbox access, cannot be requested from the dashboard, and are
 * deliberately absent from the api-keys VALID_SCOPES, so a stored key carrying
 * one of them still authorizes exactly zero tools.
 */
export const IDENTITY_SCOPES = ['openid', 'email'] as const;

/** The claims the userinfo endpoint can return, in the order OIDC names them. */
export const SUPPORTED_CLAIMS = ['sub', 'email', 'email_verified'] as const;

export function issuerBase(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://mcpemails.com';
}

/**
 * RFC 8414 Authorization Server Metadata, plus the two OIDC fields that are
 * legal here (`userinfo_endpoint` and the identity scopes).
 */
export function authorizationServerMetadata(base = issuerBase()) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    userinfo_endpoint: `${base}/api/oauth/userinfo`,
    scopes_supported: [...TOOL_SCOPES, ...IDENTITY_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
  };
}

/**
 * OpenID Connect Discovery metadata.
 *
 * NOT a claim of full OIDC conformance, and shaped so it cannot be read as
 * one. `response_types_supported` is `["code"]` alone, there is no `id_token`
 * anywhere, and no `jwks_uri`: this server issues no ID tokens, so it holds no
 * signing key, and advertising an empty or absent key set would be worse than
 * saying nothing. The claims live at the userinfo endpoint, which is what the
 * consumer of this document actually requires.
 */
export function openIdConfiguration(base = issuerBase()) {
  return {
    ...authorizationServerMetadata(base),
    subject_types_supported: ['public'],
    claims_supported: [...SUPPORTED_CLAIMS],
    claims_parameter_supported: false,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
  };
}
