import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as unmatched from '../../../app/api/[[...unmatched]]/route.ts';

/**
 * Regression test for the /api 404 fallthrough.
 *
 * THE BUG. An /api path that matched no route used to be answered by the
 * platform's not-found handling, which served app/not-found.js as HTML and,
 * on Vercel, chose its status by method:
 *
 *   GET 404 | HEAD 404 | POST 200 | PUT 200 | PATCH 200 | DELETE 200
 *
 * all six naming `x-matched-path: /_not-found`. The 200 is the damaging half:
 * every caller here does `if (!res.ok) throw` before parsing (see
 * components/dashboard/App.jsx), so a typo'd, renamed or removed endpoint read
 * as a success and then failed on res.json() of an HTML document, far from the
 * actual mistake.
 *
 * WHY THIS TEST LOOKS THE WAY IT DOES. The defect is not reproducible in
 * process, or even against a local `next start`, which answers 404 under every
 * method; it is introduced by the deployment platform on paths that reach no
 * function. So there is nothing here to assert against a server. What CAN be
 * held in place is the thing that keeps the platform out of it: a route
 * handler that answers every method, positioned where the App Router will use
 * it for unmatched paths. Both halves are asserted, because either one can
 * regress on its own; in particular, renaming or moving the directory would
 * restore the fallthrough while leaving the status assertions passing.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '../../../app/api');

/** The methods measured as broken in production, plus the two that were not. */
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

describe('unmatched /api routes', () => {
  for (const method of METHODS) {
    test(`${method} answers 404 with a JSON body`, async () => {
      const handler = unmatched[method] as (() => Response) | undefined;
      assert.equal(
        typeof handler,
        'function',
        `${method} is not exported, so an unmatched /api path falls through to ` +
          'the HTML not-found page for it',
      );

      const response = handler!();

      assert.equal(response.status, 404, `${method} must answer 404, not ${response.status}`);
      assert.match(
        response.headers.get('content-type') ?? '',
        /application\/json/,
        `${method} must answer JSON, not HTML`,
      );
      assert.equal(
        response.headers.get('cache-control'),
        'no-store',
        `a cached 404 would outlive the fix for the URL that caused it (${method})`,
      );
      assert.deepEqual(await response.json(), { error: 'Not found.' });
    });
  }

  test('every method answers identically, so behaviour cannot depend on the verb', async () => {
    const answers = await Promise.all(
      METHODS.map(async (method) => {
        const response = (unmatched[method] as () => Response)();
        return `${response.status} ${response.headers.get('content-type')} ${await response.text()}`;
      }),
    );
    assert.equal(new Set(answers).size, 1, `methods disagree: ${JSON.stringify(answers)}`);
  });

  test('the handler is the OPTIONAL catch-all directly under app/api', () => {
    assert.ok(
      existsSync(path.join(API_DIR, '[[...unmatched]]', 'route.ts')),
      'app/api/[[...unmatched]]/route.ts must exist, or unmatched /api paths fall ' +
        'through to the HTML /_not-found page again. The optional form matters: ' +
        'a required catch-all ([...unmatched]) leaves a bare /api unmatched, and ' +
        'that one path then keeps the original defect',
    );
  });

  test('no second dynamic segment competes with the catch-all', () => {
    const dynamicSiblings = readdirSync(API_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('['))
      .map((entry) => entry.name);

    assert.deepEqual(
      dynamicSiblings,
      ['[[...unmatched]]'],
      'a second dynamic segment directly under app/api is a build error in Next ' +
        'and would shadow or break the 404 catch-all',
    );
  });
});
