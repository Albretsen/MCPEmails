// ---------------------------------------------------------------------------
// The three OAuth discovery documents, pinned byte for byte.
//
//   /.well-known/oauth-authorization-server      (RFC 8414)
//   /.well-known/oauth-protected-resource        (RFC 9728)
//   /.well-known/oauth-protected-resource/<any>  (RFC 9728 path-suffixed form)
//   /.well-known/openid-configuration            (OIDC Discovery)
//
// WHY THIS EXISTS. These responses are candidates for shared (CDN) caching. A
// shared cache keys on host, path and query; it does not key on cookies,
// Origin, Authorization or any other request header. So a response is only
// safe to cache there if its status, headers and body are the same for every
// requester of a given URL. This file proves which inputs change the response
// and which do not:
//
//   DOES NOT VARY: Host, path suffix, query string, Origin, Cookie,
//                  Authorization, Accept-Language, forwarded-host headers.
//                  The handlers take no request argument at all, which is
//                  asserted structurally (GET.length === 0) as well as by
//                  calling them with hostile requests.
//   DOES VARY:     NEXT_PUBLIC_APP_URL, a deploy-time constant. It is the same
//                  for every request a given deployment serves.
//
// The expected bodies are literal strings on purpose. A test that rebuilt them
// from lib/oauth/metadata.ts would pass no matter what that module returned.
//
// Run: node --test --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs \
//        app/.well-known/discovery-documents.test.ts
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as authorizationServer from './oauth-authorization-server/route.ts';
import * as protectedResource from './oauth-protected-resource/route.ts';
import * as openIdConfiguration from './openid-configuration/route.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// EXPECTATION DATA. Everything below this banner, down to the next one, is
// data: what the documents are expected to return. The checks further down are
// logic and do not change when a header value here does.
// ---------------------------------------------------------------------------

/** Response headers of a 200, exactly these and no others, sorted by name. */
const EXPECTED_GET_HEADERS: Array<[string, string]> = [
  ['access-control-allow-headers', 'Content-Type'],
  ['access-control-allow-methods', 'GET, OPTIONS'],
  ['access-control-allow-origin', '*'],
  ['cache-control', 'max-age=3600'],
  ['content-type', 'application/json'],
];

/** Response headers of the CORS preflight, exactly these and no others. */
const EXPECTED_OPTIONS_HEADERS: Array<[string, string]> = [
  ['access-control-allow-headers', 'Content-Type'],
  ['access-control-allow-methods', 'GET, OPTIONS'],
  ['access-control-allow-origin', '*'],
];

const SCOPES =
  '"read:email","search:email","send:email","manage:folders","delete:email","manage:drafts","manage:contacts","schedule:email","manage:automations"';

/** The exact body of each document for a given app origin. */
function expectedBodies(base: string) {
  const authorizationServerBody =
    `{"issuer":"${base}","authorization_endpoint":"${base}/authorize","token_endpoint":"${base}/api/oauth/token",` +
    `"registration_endpoint":"${base}/api/oauth/register","revocation_endpoint":"${base}/api/oauth/revoke",` +
    `"userinfo_endpoint":"${base}/api/oauth/userinfo","scopes_supported":[${SCOPES},"openid","email"],` +
    `"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],` +
    `"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],` +
    `"revocation_endpoint_auth_methods_supported":["none"],"client_id_metadata_document_supported":true`;
  return {
    authorizationServer: `${authorizationServerBody}}`,
    protectedResource:
      `{"resource":"${base}/api/mcp","authorization_servers":["${base}"],"bearer_methods_supported":["header"],` +
      `"scopes_supported":[${SCOPES}]}`,
    openIdConfiguration:
      `${authorizationServerBody},"subject_types_supported":["public"],"claims_supported":["sub","email","email_verified"],` +
      `"claims_parameter_supported":false,"request_parameter_supported":false,"request_uri_parameter_supported":false}`,
  };
}

/** The origin used when NEXT_PUBLIC_APP_URL is unset. */
const DEFAULT_BASE = 'https://mcpemails.com';

// ---------------------------------------------------------------------------
// LOGIC.
// ---------------------------------------------------------------------------

type Handler = (request?: Request) => Response | Promise<Response>;

const DOCUMENTS = [
  {
    name: 'oauth-authorization-server',
    path: '/.well-known/oauth-authorization-server',
    source: 'oauth-authorization-server/route.ts',
    get: authorizationServer.GET as unknown as Handler,
    options: authorizationServer.OPTIONS as unknown as Handler,
    body: (base: string) => expectedBodies(base).authorizationServer,
  },
  {
    name: 'oauth-protected-resource',
    path: '/.well-known/oauth-protected-resource',
    source: 'oauth-protected-resource/route.ts',
    get: protectedResource.GET as unknown as Handler,
    options: protectedResource.OPTIONS as unknown as Handler,
    body: (base: string) => expectedBodies(base).protectedResource,
  },
  {
    name: 'openid-configuration',
    path: '/.well-known/openid-configuration',
    source: 'openid-configuration/route.ts',
    get: openIdConfiguration.GET as unknown as Handler,
    options: openIdConfiguration.OPTIONS as unknown as Handler,
    body: (base: string) => expectedBodies(base).openIdConfiguration,
  },
] as const;

/**
 * Requests that differ in everything a shared cache does NOT key on, plus the
 * things it does (host, path suffix, query), so both kinds are shown to leave
 * the response untouched.
 */
function hostileRequests(documentPath: string): Array<{ label: string; request: Request | undefined }> {
  return [
    { label: 'no request object at all', request: undefined },
    { label: 'canonical host', request: new Request(`https://mcpemails.com${documentPath}`) },
    { label: 'www host', request: new Request(`https://www.mcpemails.com${documentPath}`) },
    { label: 'deployment host', request: new Request(`https://mcp-emails-web-abc123.vercel.app${documentPath}`) },
    { label: 'attacker host', request: new Request(`https://evil.example${documentPath}`) },
    { label: 'path suffix', request: new Request(`https://mcpemails.com${documentPath}/api/mcp`) },
    { label: 'other path suffix', request: new Request(`https://mcpemails.com${documentPath}/tenant/other`) },
    { label: 'query string', request: new Request(`https://mcpemails.com${documentPath}?resource=https%3A%2F%2Fevil.example&x=1`) },
    {
      label: 'forwarded host headers',
      request: new Request(`https://mcpemails.com${documentPath}`, {
        headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example' },
      }),
    },
    {
      label: 'origin, cookie, authorization, language',
      request: new Request(`https://mcpemails.com${documentPath}`, {
        headers: {
          origin: 'https://claude.ai',
          cookie: 'sb-access-token=abc; mx_subject=0123456789abcdef0123456789abcdef',
          authorization: 'Bearer mcpe_not_a_real_key',
          'accept-language': 'nb-NO,nb;q=0.9',
          accept: 'text/html',
          'user-agent': 'node',
        },
      }),
    },
  ];
}

function sortedHeaders(response: Response): Array<[string, string]> {
  return [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
}

async function withAppUrl<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous;
  }
}

for (const document of DOCUMENTS) {
  test(`${document.name}: status, headers and exact body, identical for every requester`, async () => {
    await withAppUrl(undefined, async () => {
      for (const { label, request } of hostileRequests(document.path)) {
        const response = await document.get(request);
        assert.equal(response.status, 200, `${label}: status`);
        assert.deepEqual(sortedHeaders(response), EXPECTED_GET_HEADERS, `${label}: headers`);
        assert.equal(await response.text(), document.body(DEFAULT_BASE), `${label}: body`);
      }
    });
  });

  test(`${document.name}: the only thing that changes the body is the deploy-time app URL`, async () => {
    await withAppUrl('https://staging.example.test', async () => {
      for (const { label, request } of hostileRequests(document.path)) {
        const response = await document.get(request);
        assert.equal(response.status, 200, `${label}: status`);
        assert.deepEqual(sortedHeaders(response), EXPECTED_GET_HEADERS, `${label}: headers`);
        assert.equal(await response.text(), document.body('https://staging.example.test'), `${label}: body`);
      }
    });
    assert.notEqual(document.body('https://staging.example.test'), document.body(DEFAULT_BASE));
  });

  test(`${document.name}: no Set-Cookie and no Vary from the handler`, async () => {
    const response = await document.get(new Request(`https://mcpemails.com${document.path}`));
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('vary'), null);
    assert.deepEqual(response.headers.getSetCookie(), []);
  });

  test(`${document.name}: the handler cannot read the request`, () => {
    // Structural, not behavioural: a handler that declares no parameter has no
    // way to branch on host, path, query or headers. If someone adds a
    // `request` parameter, shared caching of this document has to be
    // re-examined, and this is the line that says so.
    assert.equal(document.get.length, 0, 'GET must declare no parameters');
    const source = readFileSync(path.join(HERE, document.source), 'utf8');
    for (const forbidden of ['next/headers', 'NextRequest', 'cookies(', 'headers(']) {
      assert.ok(!source.includes(forbidden), `${document.source} must not use ${forbidden}`);
    }
  });

  test(`${document.name}: the CORS preflight is unchanged`, async () => {
    const response = await document.options(new Request(`https://mcpemails.com${document.path}`, { method: 'OPTIONS' }));
    assert.equal(response.status, 204);
    assert.deepEqual(sortedHeaders(response), EXPECTED_OPTIONS_HEADERS);
    assert.equal(await response.text(), '');
  });
}

test('the path-suffixed protected-resource route is the root route, re-exported', () => {
  // RFC 9728 lets a client ask for /.well-known/oauth-protected-resource/<path>.
  // Some servers answer with per-resource metadata there. This one must not:
  // the catch-all file is a bare re-export of the root handlers, so every
  // suffix returns the same bytes as the root document. (It is checked as text
  // because its extensionless `../route` import only resolves under the Next
  // bundler, not under plain `node --test`.)
  const source = readFileSync(path.join(HERE, 'oauth-protected-resource/[...resource]/route.ts'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(code, "export { GET, OPTIONS } from '../route';");
});

test('the two authorization-server documents agree on every shared field', async () => {
  await withAppUrl(undefined, async () => {
    const oauth = JSON.parse(await (await DOCUMENTS[0].get()).text()) as Record<string, unknown>;
    const oidc = JSON.parse(await (await DOCUMENTS[2].get()).text()) as Record<string, unknown>;
    for (const [key, value] of Object.entries(oauth)) assert.deepEqual(oidc[key], value, key);
  });
});
