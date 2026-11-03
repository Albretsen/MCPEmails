// readBodyWithLimit: byte cap on a streamed request body.
// Run with: npm run test:support
import assert from 'node:assert/strict';
import test from 'node:test';

import { readBodyWithLimit } from './read-body.ts';

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('https://mcpemails.test/x', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

test('a body under the cap is returned as text', async () => {
  assert.deepEqual(await readBodyWithLimit(req('{"a":1}'), 100), { ok: true, text: '{"a":1}' });
});

test('an empty body is an empty string', async () => {
  assert.deepEqual(await readBodyWithLimit(req(null), 100), { ok: true, text: '' });
});

test('the cap counts bytes, not characters', async () => {
  // 10 characters, 30 bytes of UTF-8.
  const cjk = '字'.repeat(10);
  assert.equal((await readBodyWithLimit(req(cjk), 30)).ok, true);
  assert.deepEqual(await readBodyWithLimit(req(cjk), 29), { ok: false, reason: 'too_large' });
});

test('a declared Content-Length over the cap is refused before reading', async () => {
  assert.deepEqual(await readBodyWithLimit(req('x', { 'content-length': '5000' }), 100), { ok: false, reason: 'too_large' });
});

test('a streamed body is cancelled once it passes the cap', async () => {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64));
    },
    cancel() {
      cancelled = true;
    },
  });
  const res = await readBodyWithLimit(req(stream), 200);
  assert.deepEqual(res, { ok: false, reason: 'too_large' });
  assert.equal(cancelled, true);
  assert.ok(pulled <= 5, `pulled ${pulled} chunks`);
});
