// ---------------------------------------------------------------------------
// signature-editor-loader.mjs: the real loader, and the import graph it exists
// to keep.
//
// Run with: npm run test:signature-editor-ui
//
// signature-editor-lazy.test.mjs replaces this module to control timing. This
// file runs the real one, and reads the source of the three files involved,
// because the property being protected cannot be seen in a render:
//
//   - Pages.jsx must not statically import the editor, the sanitiser, TipTap
//     or DOMPurify. One such import puts ~460 KB back in every dashboard load.
//   - There is ONE sanitiser. The loader hands the form the same function the
//     editor imports for itself, from the same module, so the preview, the
//     save and the editor cannot drift onto different allow-lists.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom } from '../../scripts/test-dom.mjs';

installDom();

const { loadSignatureEditor, peekSignatureEditor, warmSignatureEditor } = await import('./signature-editor-loader.mjs');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const staticImports = (source) => source.split('\n').filter((line) => /^\s*import\b[^(]*\bfrom\b/.test(line) || /^\s*\}\s*from\b/.test(line));

test('nothing is loaded until it is asked for', () => {
  assert.equal(peekSignatureEditor(), null);
});

test('load: resolves with the editor component and the shared sanitiser, and keeps them', async () => {
  const [a, b] = await Promise.all([loadSignatureEditor(), loadSignatureEditor()]);
  assert.equal(a, b, 'concurrent calls share one load');
  assert.deepEqual(Object.keys(a).sort(), ['SignatureRichEditor', 'sanitizeSignatureHtml']);
  assert.ok(a.SignatureRichEditor, 'the editor component is there');
  assert.equal(typeof a.sanitizeSignatureHtml, 'function');
  assert.equal(peekSignatureEditor(), a, 'available synchronously from now on');
  assert.equal(await loadSignatureEditor(), a, 'and the same object every time');

  const direct = await import('./SignatureRichEditor.jsx');
  assert.equal(a.SignatureRichEditor, direct.default, 'it is the real editor, not a copy');
});

test('one sanitiser: the function handed to the form IS the module the editor imports', async () => {
  const pair = await loadSignatureEditor();
  const shared = await import('../../src/lib/sanitizeSignatureHtml.js');
  assert.equal(pair.sanitizeSignatureHtml, shared.sanitizeSignatureHtml);
  // And it sanitises: the allow-list is live, not a pass-through.
  assert.equal(pair.sanitizeSignatureHtml('<p onclick="x()">Ada</p><script>1</script>'), '<p>Ada</p>');

  const editorSource = read('./SignatureRichEditor.jsx');
  assert.ok(staticImports(editorSource).some((l) => l.includes("from '@/lib/sanitizeSignatureHtml'")),
    'the editor still imports the shared sanitiser, it does not carry its own');
});

test('warm: starts a load and never rejects', async () => {
  assert.equal(warmSignatureEditor(), undefined);
  assert.ok(peekSignatureEditor() || (await loadSignatureEditor()));
});

test('Pages.jsx reaches the editor, the sanitiser, TipTap and DOMPurify only through the loader', () => {
  const pages = staticImports(read('./Pages.jsx'));
  const offenders = pages.filter((line) => /SignatureRichEditor|sanitizeSignatureHtml|@tiptap|dompurify/i.test(line));
  assert.deepEqual(offenders, [], 'a static import here puts the editor back in the dashboard first load');
  assert.ok(pages.some((line) => line.includes("from './signature-editor-loader.mjs'")));

  const loader = read('./signature-editor-loader.mjs');
  assert.deepEqual(staticImports(loader), [], 'the loader itself imports nothing statically');
  assert.ok(loader.includes("import('./SignatureRichEditor')"), 'the editor is behind a literal import()');
  assert.ok(loader.includes("import('@/lib/sanitizeSignatureHtml')"), 'the sanitiser is behind a literal import()');
});

test('no other dashboard component statically imports the editor or the DOMPurify sanitiser', () => {
  for (const file of ['./App.jsx', './Sidebar.jsx', './ConnectModal.jsx', './AutomationsPanel.jsx', './ApprovalsPanel.jsx']) {
    const offenders = staticImports(read(file)).filter((line) => /SignatureRichEditor|sanitizeSignatureHtml'|@tiptap|dompurify/i.test(line));
    assert.deepEqual(offenders, [], file);
  }
});
