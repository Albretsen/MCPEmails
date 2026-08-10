import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeSignatureHtml } from './sanitizeSignatureHtml.js';

test('shared signature sanitizer imports and runs without jsdom during SSR', () => {
  const clean = sanitizeSignatureHtml(
    '<p onclick="alert(1)">Hello<script>alert(1)</script><a href="javascript:alert(1)">link</a></p>',
  );

  assert.equal(clean.includes('<script'), false);
  assert.equal(clean.includes('onclick'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.match(clean, /Hello/);
});
