import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'net';
import {
  mailRelayConfigFromEnv,
  openMailRelayTunnel,
  MailRelayUnavailableError,
} from './mail-relay.ts';

/** A one-shot fake proxy: answers the first request with `reply`, then echoes. */
function fakeProxy(reply: string, onRequest?: (head: string) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let head = '';
      let answered = false;
      socket.on('data', (chunk) => {
        if (answered) { socket.write(chunk); return; }
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        answered = true;
        onRequest?.(head);
        socket.write(reply);
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

test('the relay is read from MAIL_RELAY_URL, credential and all', () => {
  const config = mailRelayConfigFromEnv({ MAIL_RELAY_URL: 'http://relay:s%40cret@203.0.113.7:3128' });
  assert.deepEqual(config, {
    host: '203.0.113.7',
    port: 3128,
    authorization: `Basic ${Buffer.from('relay:s@cret').toString('base64')}`,
  });
  assert.equal(mailRelayConfigFromEnv({ MAIL_RELAY_URL: 'http://203.0.113.7' })?.port, 3128);
  assert.equal(mailRelayConfigFromEnv({ MAIL_RELAY_URL: 'http://203.0.113.7' })?.authorization, null);
});

test('an unset or unusable relay URL means no relay, never an error', () => {
  assert.equal(mailRelayConfigFromEnv({}), null);
  assert.equal(mailRelayConfigFromEnv({ MAIL_RELAY_URL: '   ' }), null);
  assert.equal(mailRelayConfigFromEnv({ MAIL_RELAY_URL: 'not a url' }), null);
  // TLS to the relay is not supported: see smtp-relay.ts for why.
  assert.equal(mailRelayConfigFromEnv({ MAIL_RELAY_URL: 'https://203.0.113.7:3128' }), null);
});

test('a 200 hands back a socket that carries bytes both ways', async () => {
  let seen = '';
  const proxy = await fakeProxy('HTTP/1.1 200 Connection established\r\n\r\n', (head) => { seen = head; });
  try {
    const socket = await openMailRelayTunnel(
      { host: '127.0.0.1', port: proxy.port, authorization: 'Basic abc' },
      'imap.example.com',
      993
    );
    assert.match(seen, /^CONNECT imap\.example\.com:993 HTTP\/1\.1\r\n/);
    assert.match(seen, /\r\nProxy-Authorization: Basic abc\r\n/);
    const echoed = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString()));
      socket.write('ping');
    });
    assert.equal(echoed, 'ping');
    socket.destroy();
  } finally {
    proxy.close();
  }
});

test('a refusal from the relay is a relay failure and repeats only the status', async () => {
  const proxy = await fakeProxy('HTTP/1.1 403 Filtered\r\nContent-Type: text/html\r\n\r\n<h1>secret page</h1>');
  try {
    await assert.rejects(
      openMailRelayTunnel({ host: '127.0.0.1', port: proxy.port, authorization: null }, 'imap.example.com', 993),
      (error: unknown) => {
        assert.ok(error instanceof MailRelayUnavailableError);
        assert.match(error.message, /403/);
        assert.doesNotMatch(error.message, /secret page/);
        return true;
      }
    );
  } finally {
    proxy.close();
  }
});

test('a relay that never answers is given up on', async () => {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await assert.rejects(
      openMailRelayTunnel({ host: '127.0.0.1', port, authorization: null }, 'imap.example.com', 993, 150),
      MailRelayUnavailableError
    );
  } finally {
    server.close();
  }
});

test('a target that is not a plain host and port never reaches the request line', async () => {
  let requested = false;
  const proxy = await fakeProxy('HTTP/1.1 200 OK\r\n\r\n', () => { requested = true; });
  try {
    for (const host of ['imap.example.com\r\nX-Injected: 1', 'imap.example.com:25', '']) {
      await assert.rejects(
        openMailRelayTunnel({ host: '127.0.0.1', port: proxy.port, authorization: null }, host, 993),
        MailRelayUnavailableError
      );
    }
    assert.equal(requested, false);
  } finally {
    proxy.close();
  }
});
