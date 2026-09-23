import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chooseImapPasswordMechanism,
  cramMd5Response,
  imapLoginArgument,
  parseImapCapabilities,
} from './imap-auth.ts';
import { authenticateImapPassword } from './validate-imap.ts';

// The exhaustive suite (RFC 1321 / 2104 / 2195 vectors, the mechanism rule,
// redaction, and wire transcripts through the edge client) lives with the edge
// function's copy in supabase/functions/mcp-server/imap-auth.test.ts. What is
// checked here is (a) that this copy agrees on the cases that matter, (b) that
// the copies have not drifted, and (c) that the connect-time validator puts the
// rule on the wire, against a scripted server.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDGE_COPY = path.resolve(HERE, '../../../../../supabase/functions/mcp-server/imap-auth.ts');

const EARTHLINK_CAPS =
  '* CAPABILITY IMAP4 IMAP4rev1 QUOTA LITERAL+ UIDPLUS NO_ATOMIC_RENAME UNSELECT SORT X-Move X-Count THREAD=ORDEREDSUBJECT THREAD=REFERENCES AUTH=CRAM-MD5 AUTH=EL-TAC AUTH=EL-VOICE STARTTLS ID CHILDREN';
const RFC2195_CHALLENGE = '+ PDE4OTYuNjk3MTcwOTUyQHBvc3RvZmZpY2UucmVzdG9uLm1jaS5uZXQ+';
const RFC2195_RESPONSE = 'dGltIGI5MTNhNjAyYzdlZGE3YTQ5NWI0ZTZlNzMzNGQzODkw';

test('CRAM-MD5 reproduces the RFC 2195 example', () => {
  assert.equal(cramMd5Response('tim', 'tanstaaftanstaaf', RFC2195_CHALLENGE), RFC2195_RESPONSE);
});

test('the mechanism rule: PLAIN wherever it is today, LOGIN where PLAIN cannot work', () => {
  const choose = (line: string | null) =>
    chooseImapPasswordMechanism(line === null ? null : parseImapCapabilities([line]));
  assert.equal(choose(null), 'PLAIN');
  assert.equal(choose('* CAPABILITY IMAP4rev1 ID'), 'PLAIN');
  assert.equal(choose('* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] ready'), 'PLAIN');
  assert.equal(choose(EARTHLINK_CAPS), 'LOGIN');
  assert.equal(choose('* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=CRAM-MD5'), 'CRAM-MD5');
  assert.deepEqual(imapLoginArgument('a"b'), { kind: 'quoted', text: '"a\\"b"' });
});

test('the two copies of the IMAP auth module agree', () => {
  // Same arrangement as utf7.ts: the edge function cannot import from here, so
  // the code is duplicated and this fails the build when the copies drift.
  const ANCHOR = 'export type ImapPasswordMechanism =';
  const bodies = [path.join(HERE, 'imap-auth.ts'), EDGE_COPY].map((file) => {
    const source = fs.readFileSync(file, 'utf8');
    const at = source.indexOf(ANCHOR);
    assert.notEqual(at, -1, `${file} no longer contains "${ANCHOR}"`);
    return source.slice(at);
  });
  assert.equal(bodies[0], bodies[1], 'the web and edge copies of imap-auth.ts have drifted; make them identical again');
});

/**
 * Run `authenticateImapPassword` against a one-connection fake server on
 * localhost. `respond` gets each line the client sends (without CRLF) and
 * returns what the server writes back, if anything.
 */
async function transcript(
  greeting: string | null,
  username: string,
  password: string,
  respond: (line: string) => string | undefined
) {
  const received: string[] = [];
  const server = net.createServer((conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let at = buffer.indexOf('\r\n');
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        received.push(line);
        const reply = respond(line);
        if (reply) conn.write(reply);
        at = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  try {
    const result = await authenticateImapPassword(socket, greeting, username, password);
    return { result, received };
  } finally {
    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('validator on EarthLink: asks CAPABILITY, then sends LOGIN, never AUTHENTICATE', async () => {
  const { result, received } = await transcript(
    '* OK earthlink.net IMAP Service imapd ready',
    'someone@earthlink.net',
    'correct horse',
    (line) => {
      if (line === 'C0001 CAPABILITY') return `${EARTHLINK_CAPS}\r\nC0001 OK Completed\r\n`;
      if (line.startsWith('L0001 LOGIN ')) return 'L0001 NO Login failed Login incorrect\r\n';
      return undefined;
    }
  );
  assert.equal(result.mechanism, 'LOGIN');
  assert.equal(result.status, 'NO');
  assert.equal(result.text, 'Login failed Login incorrect');
  assert.deepEqual(received, ['C0001 CAPABILITY', 'L0001 LOGIN "someone@earthlink.net" "correct horse"']);
});

test('validator LOGIN sends a non-ASCII password as a synchronizing literal', async () => {
  const { result, received } = await transcript(null, 'someone@earthlink.net', 'blåbær', (line) => {
    if (line === 'C0001 CAPABILITY') return `${EARTHLINK_CAPS}\r\nC0001 OK Completed\r\n`;
    if (/\{\d+\}$/.test(line)) return '+ go ahead\r\n';
    if (line === Buffer.from('blåbær', 'utf8').toString('latin1')) return 'L0001 OK LOGIN completed\r\n';
    return undefined;
  });
  assert.equal(result.status, 'OK');
  assert.equal(received[1], 'L0001 LOGIN "someone@earthlink.net" {8}');
});

test('validator keeps PLAIN, byte for byte, when the greeting advertises it (no extra round trip)', async () => {
  const token = Buffer.from('\x00me@example.com\x00pw', 'utf8').toString('base64');
  const { result, received } = await transcript(
    '* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN AUTH=LOGIN] Dovecot ready.',
    'me@example.com',
    'pw',
    (line) => (line.startsWith('A0001 ') ? 'A0001 OK Logged in\r\n' : undefined)
  );
  assert.equal(result.mechanism, 'PLAIN');
  assert.equal(result.status, 'OK');
  assert.deepEqual(received, [`A0001 AUTHENTICATE PLAIN ${token}`]);
});

test('validator keeps the PLAIN two-step retry for servers without SASL-IR', async () => {
  const token = Buffer.from('\x00me@yandex.ru\x00pw', 'utf8').toString('base64');
  const { result, received } = await transcript(null, 'me@yandex.ru', 'pw', (line) => {
    if (line === 'C0001 CAPABILITY') return '* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2\r\nC0001 OK done\r\n';
    if (line.startsWith('A0001 ')) return 'A0001 BAD AUTHENTICATE Command syntax error\r\n';
    if (line === 'A0002 AUTHENTICATE PLAIN') return '+\r\n';
    if (line === token) return 'A0002 OK Authenticated\r\n';
    return undefined;
  });
  assert.equal(result.status, 'OK');
  assert.deepEqual(received, [
    'C0001 CAPABILITY',
    `A0001 AUTHENTICATE PLAIN ${token}`,
    'A0002 AUTHENTICATE PLAIN',
    token,
  ]);
});

test('validator runs the RFC 2195 CRAM-MD5 transcript when LOGIN is disabled', async () => {
  const { result, received } = await transcript(null, 'tim', 'tanstaaftanstaaf', (line) => {
    if (line === 'C0001 CAPABILITY') return '* CAPABILITY IMAP4rev1 LOGINDISABLED AUTH=CRAM-MD5\r\nC0001 OK done\r\n';
    if (line === 'M0001 AUTHENTICATE CRAM-MD5') return `${RFC2195_CHALLENGE}\r\n`;
    if (line === RFC2195_RESPONSE) return 'M0001 OK CRAM authentication successful\r\n';
    return 'M0001 NO wrong\r\n';
  });
  assert.equal(result.mechanism, 'CRAM-MD5');
  assert.equal(result.status, 'OK');
  assert.equal(result.token, RFC2195_RESPONSE, 'the response is returned so the caller can redact it');
  assert.ok(!received.join('\n').includes('tanstaaf'), 'the password never goes on the wire');
});
