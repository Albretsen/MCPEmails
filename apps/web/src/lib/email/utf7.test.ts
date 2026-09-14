import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeModifiedUtf7, encodeModifiedUtf7 } from './utf7.ts';
import { parseListResponse, quoteMailbox, quoteListPattern } from './imap.ts';

// The exhaustive codec suite (23 cases plus a 200k round-trip fuzz) lives with
// the edge function's copy, in supabase/functions/mcp-server/utf7.test.ts. What
// is checked here is (a) that this copy behaves the same on the cases that
// matter, (b) that the copies have not drifted, and (c) that the web IMAP
// client actually puts the codec on both ends of the wire.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDGE_COPY = path.resolve(HERE, '../../../../../supabase/functions/mcp-server/utf7.ts');

// The production name from the bug report: an Arabic folder on Migadu.
const ARABIC = 'مجلد اختبار';
const ARABIC_WIRE = '&BkUGLAZEBi8- &BicGLgYqBigGJwYx-';

test('the reported folder name survives the round trip in both directions', () => {
  assert.equal(encodeModifiedUtf7(ARABIC), ARABIC_WIRE);
  assert.equal(decodeModifiedUtf7(ARABIC_WIRE), ARABIC);
});

test('printable ASCII is left alone and "&" is escaped', () => {
  assert.equal(encodeModifiedUtf7('INBOX'), 'INBOX');
  assert.equal(encodeModifiedUtf7('[Gmail]/All Mail'), '[Gmail]/All Mail');
  assert.equal(encodeModifiedUtf7('Tom & Jerry'), 'Tom &- Jerry');
  assert.equal(decodeModifiedUtf7('Tom &- Jerry'), 'Tom & Jerry');
});

test('decoding is total: junk comes back verbatim rather than half-mangled', () => {
  // A name we cannot interpret is still a name we can hand back to the server.
  for (const junk of ['&', '&AAA', '&!!!-', 'Dossier café', '&&-']) {
    assert.equal(decodeModifiedUtf7(junk), junk, junk);
  }
});

test('the two copies of the modified-UTF-7 codec agree', () => {
  // This module and supabase/functions/mcp-server/utf7.ts hold the same code
  // because they run in two runtimes that cannot import from one another: the
  // edge function is deployed on its own and bundles only what lives under
  // supabase/functions/. If the copies drift, a folder name is readable on one
  // surface and a wire string on the other, which is the bug this exists to
  // close. Compare the source text below the header comment, which is the only
  // part either file is allowed to write for itself.
  const ANCHOR = 'const ALPHABET =';
  const bodies = [path.join(HERE, 'utf7.ts'), EDGE_COPY].map((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const at = source.indexOf(ANCHOR);
    assert.notEqual(at, -1, `${file} no longer contains "${ANCHOR}" — the copies have drifted`);
    return source.slice(at);
  });
  assert.equal(
    bodies[0],
    bodies[1],
    'the web copy of the codec and the edge function copy have drifted; make them identical again'
  );
});

// ── The client boundary ───────────────────────────────────────────────────────

test('LIST names are decoded as they come off the socket', () => {
  const parsed = parseListResponse([
    '* LIST (\\HasNoChildren) "/" "INBOX"',
    `* LIST (\\HasNoChildren) "/" "${ARABIC_WIRE}"`,
    '* LIST (\\HasNoChildren) "/" "&UXZO1mWHTvZZOQ-"',
    '* LIST (\\Noselect \\HasChildren) NIL "&BkUGLAZEBi8-"',
  ]);
  assert.deepEqual(parsed.map((m) => m.name), ['INBOX', ARABIC, '其他文件夹', 'مجلد']);
  assert.deepEqual(parsed[0].attributes, ['\\HasNoChildren']);
  assert.equal(parsed[3].delimiter, '/', 'a NIL delimiter still falls back to "/"');
});

test('a name a server sent unencoded is not mangled on the way in', () => {
  // Servers that never implemented 5.1.3 exist. Their names have no "&" run and
  // must come through untouched.
  const parsed = parseListResponse(['* LIST () "." Wichtig']);
  assert.equal(parsed[0].name, 'Wichtig');
});

test('a quoted name keeps its escapes intact through the round trip', () => {
  // The parser unescapes because the writer escapes; if only one half did it,
  // the name shown and the name selected would be different folders.
  const parsed = parseListResponse(['* LIST () "/" "a\\\\b\\"c"']);
  assert.equal(parsed[0].name, 'a\\b"c');
  assert.equal(quoteMailbox(parsed[0].name), '"a\\\\b\\"c"');
});

test('SELECT-bound names are encoded, so a listed name can be selected', () => {
  assert.equal(quoteMailbox('INBOX'), '"INBOX"');
  assert.equal(quoteMailbox(ARABIC), `"${ARABIC_WIRE}"`);
  // Round trip through the pair the client actually uses.
  const listed = parseListResponse([`* LIST () "/" "${ARABIC_WIRE}"`])[0].name;
  assert.equal(quoteMailbox(listed), `"${ARABIC_WIRE}"`);
});

test('a control character is refused before the encoder can launder it', () => {
  // CRLF in a folder name would end the command line and let the remainder be
  // read as further IMAP commands. The guard has to run on the caller's string,
  // because after encoding the CRLF is an innocuous-looking BASE64 run.
  assert.throws(() => quoteMailbox('INBOX\r\nA001 DELETE "Sent"'), /control characters/);
  assert.throws(() => quoteListPattern('*\r\nA001 LOGOUT'), /control characters/);
  // And it is refused rather than silently encoded.
  assert.ok(encodeModifiedUtf7('\r\n').startsWith('&'), 'the encoder would have hidden it');
});

test('LIST wildcards survive the encoder', () => {
  assert.equal(quoteListPattern('*'), '"*"');
  assert.equal(quoteListPattern('%'), '"%"');
  assert.equal(quoteListPattern('مجلد*'), '"&BkUGLAZEBi8-*"');
  assert.equal(quoteListPattern('INBOX/%'), '"INBOX/%"');
});
