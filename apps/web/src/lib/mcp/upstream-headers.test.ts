import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { upstreamHeaders } from './upstream-headers.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.resolve(HERE, '../../../app/api/mcp/route.ts');
const UPSTREAM_GATE = path.resolve(
  HERE,
  '../../../../../supabase/functions/mcp-server/card-build-notify.ts',
);

/**
 * The REAL upstream predicate, not a restatement of it.
 *
 * `card-build-notify.ts` has no imports and no Deno globals, so node can load
 * it directly under --experimental-strip-types. The specifier is a variable on
 * purpose: a literal cross-package import would drag a Deno module into
 * apps/web's tsconfig graph, while a computed one is invisible to tsc and
 * resolved only at run time.
 *
 * This matters. An earlier version of this file kept a local copy of the
 * predicate and asserted against that, plus a `source.includes(...)` pin on the
 * edge function. Replacing the real gate's body with `return true` left all
 * twelve checks green, which is the same "satisfiable by a comment" weakness
 * this repo has caught in source pins before.
 */
let acceptsEventStream: (accept: string | null) => boolean;

before(async () => {
  const gate = await import(pathToFileURL(UPSTREAM_GATE).href);
  assert.equal(
    typeof gate.acceptsEventStream,
    'function',
    'acceptsEventStream moved or was renamed in card-build-notify.ts',
  );
  acceptsEventStream = gate.acceptsEventStream;
});

const BASE = {
  authorization: 'Bearer test-token',
  contentType: 'application/json',
};

describe('upstreamHeaders forwards what the upstream depends on', () => {
  test('a Streamable HTTP Accept is forwarded verbatim', () => {
    const accept = 'application/json, text/event-stream';
    const headers = upstreamHeaders({ ...BASE, accept });

    assert.equal(headers.Accept, accept);
    // The property that actually matters, checked against the real gate: a
    // reformatted-but-valid Accept must not pass the equality above while
    // failing the predicate in production.
    assert.ok(acceptsEventStream(headers.Accept ?? null));
  });

  test('a JSON-only client is never handed a stream', () => {
    const headers = upstreamHeaders({ ...BASE, accept: 'application/json' });

    assert.equal(headers.Accept, 'application/json');
    assert.ok(
      !acceptsEventStream(headers.Accept ?? null),
      'the proxy must not invent an SSE-capable Accept',
    );
  });

  test('an absent Accept is omitted, not fabricated', () => {
    for (const accept of [null, undefined, '']) {
      const headers = upstreamHeaders({ ...BASE, accept });
      assert.ok(
        !('Accept' in headers),
        `Accept asserted for input ${JSON.stringify(accept)}`,
      );
    }
  });

  test('the header dropped until 2026-09-08 is still forwarded', () => {
    const headers = upstreamHeaders({ ...BASE, protocolVersion: '2025-06-18' });
    assert.equal(headers['MCP-Protocol-Version'], '2025-06-18');

    assert.ok(!('MCP-Protocol-Version' in upstreamHeaders(BASE)));
  });

  test('auth and content type always go', () => {
    const headers = upstreamHeaders(BASE);
    assert.equal(headers.Authorization, 'Bearer test-token');
    assert.equal(headers['Content-Type'], 'application/json');
  });
});

describe('the real upstream gate still rejects what the bug produced', () => {
  test('the wildcard Accept undici supplied is NOT SSE-capable', () => {
    // 2681 of 2681 requests arrived as this because the route omitted Accept.
    // If the gate ever starts accepting it, the notification would fire at
    // clients that never asked for a stream and cannot parse one.
    assert.equal(acceptsEventStream('*/*'), false);
  });

  test('nothing else reads as asking for a stream', () => {
    for (const accept of ['application/json', 'text/plain', '', null]) {
      assert.equal(
        acceptsEventStream(accept),
        false,
        `${JSON.stringify(accept)} must not read as SSE-capable`,
      );
    }
  });

  test('a conforming client does read as SSE-capable, in any case', () => {
    assert.equal(acceptsEventStream('application/json, text/event-stream'), true);
    assert.equal(acceptsEventStream('Application/JSON, TEXT/EVENT-STREAM'), true);
  });
});

describe('the route uses the module rather than rebuilding the bag', () => {
  // The whole reason this logic was extracted is that inline forwarding in a
  // route handler is unassertable. If the route stops calling the module, every
  // test above keeps passing while production regresses, which is precisely the
  // 2026-09-08 and 2026-09-17 failure mode.
  const source = readFileSync(ROUTE, 'utf8');

  test('the route builds its upstream headers here', () => {
    assert.ok(
      /upstreamHeaders\(/.test(source),
      'route no longer calls upstreamHeaders',
    );
  });

  test('the route reads the client Accept off the request', () => {
    assert.ok(
      /request\.headers\.get\(\s*['"]accept['"]\s*\)/i.test(source),
      'route no longer reads the client Accept header',
    );
  });

  test('preflight allows the headers a browser client must send', () => {
    const allow = /'Access-Control-Allow-Headers':\s*'([^']*)'/.exec(source);
    assert.ok(allow, 'Access-Control-Allow-Headers not found');
    const lower = allow[1].toLowerCase();
    for (const header of [
      'accept',
      'authorization',
      'content-type',
      'mcp-protocol-version',
    ]) {
      assert.ok(lower.includes(header), `${header} not allowed: ${allow[1]}`);
    }
  });
});
