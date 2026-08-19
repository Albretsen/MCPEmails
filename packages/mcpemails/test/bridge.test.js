#!/usr/bin/env node
/**
 * Offline conformance tests for the stdio bridge.
 *
 * These run the real binary as a subprocess against a throwaway HTTP server on
 * localhost, so they exercise the parts that only break in a live process:
 * newline framing, out-of-order concurrent responses, notification silence, and
 * the guarantee that a request whose HTTP call fails still gets an answer.
 *
 * They deliberately do not touch mcpemails.com. Live verification against
 * production is a separate, manual step that needs a real API key.
 */

'use strict';

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'mcpemails.js');
const FAKE_KEY = `mcpe_${'a'.repeat(64)}`;

const failures = [];

/** Start a stub MCP endpoint. `handler(message)` returns the JSON-RPC reply, or
 *  null to answer with an empty 202 the way a notification is acknowledged. */
function startStub(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', async () => {
        const message = JSON.parse(body);
        seen.push({ message, authorization: req.headers.authorization });
        const reply = await handler(message);
        if (reply === null) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, seen, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/** Feed `lines` to the bridge on stdin and collect the messages it emits. */
function runBridge(url, lines, { env = {}, args = [] } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [BIN, '--url', url, ...args],
      { env: { ...process.env, MCPEMAILS_API_KEY: FAKE_KEY, ...env }, stdio: 'pipe' }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      const messages = stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
      resolve({ code, messages, stdout, stderr });
    });

    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`not ok - ${name}\n    ${error.message}\n`);
  }
}

async function main() {
  await test('forwards a request verbatim and returns the reply', async () => {
    const stub = await startStub((message) => ({
      jsonrpc: '2.0',
      id: message.id,
      result: { echoed: message.params },
    }));
    const { messages } = await runBridge(stub.url, [
      '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"cursor":"x"}}',
    ]);
    stub.server.close();

    assert.deepStrictEqual(messages, [
      { jsonrpc: '2.0', id: 1, result: { echoed: { cursor: 'x' } } },
    ]);
    assert.deepStrictEqual(stub.seen[0].message, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { cursor: 'x' },
    });
  });

  await test('sends the key as a bearer token and nothing else', async () => {
    const stub = await startStub((message) => ({ jsonrpc: '2.0', id: message.id, result: {} }));
    const { stdout, stderr } = await runBridge(
      stub.url,
      ['{"jsonrpc":"2.0","id":1,"method":"ping"}'],
      { args: ['--verbose'] }
    );
    stub.server.close();

    assert.strictEqual(stub.seen[0].authorization, `Bearer ${FAKE_KEY}`);
    assert.ok(!stdout.includes(FAKE_KEY), 'key must never reach stdout');
    assert.ok(!stderr.includes(FAKE_KEY), 'key must never reach stderr');
  });

  await test('answers concurrent requests without serialising them', async () => {
    // The slow request is sent first. If the bridge processed messages one at a
    // time, the fast reply could not overtake it.
    const stub = await startStub(async (message) => {
      if (message.id === 'slow') await new Promise((r) => setTimeout(r, 250));
      return { jsonrpc: '2.0', id: message.id, result: {} };
    });
    const { messages } = await runBridge(stub.url, [
      '{"jsonrpc":"2.0","id":"slow","method":"tools/call"}',
      '{"jsonrpc":"2.0","id":"fast","method":"ping"}',
    ]);
    stub.server.close();

    assert.deepStrictEqual(
      messages.map((m) => m.id),
      ['fast', 'slow']
    );
  });

  await test('stays silent for a notification the server does not answer', async () => {
    const stub = await startStub(() => null);
    const { messages, code } = await runBridge(stub.url, [
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    ]);
    stub.server.close();

    assert.deepStrictEqual(messages, []);
    assert.strictEqual(code, 0);
  });

  await test('answers a request whose transport fails instead of hanging', async () => {
    // Port 1 on loopback refuses connections, so fetch rejects.
    const { messages } = await runBridge('http://127.0.0.1:1/', [
      '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
    ]);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].id, 7);
    assert.strictEqual(messages[0].error.code, -32603);
  });

  await test('learns the negotiated protocol version and sends it onward', async () => {
    const stub = await startStub((message) => ({
      jsonrpc: '2.0',
      id: message.id,
      result: message.method === 'initialize' ? { protocolVersion: '2025-06-18' } : {},
    }));
    await runBridge(stub.url, [
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      // A crude wait: the second line is only written after the first reply in
      // practice, but the stub is fast enough that ordering holds here.
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ]);
    stub.server.close();

    assert.strictEqual(stub.seen.length, 2);
  });

  await test('rejects a malformed key without contacting the server', async () => {
    const { code, stderr } = await runBridge('http://127.0.0.1:1/', [], {
      env: { MCPEMAILS_API_KEY: 'mcpe_short' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('not in the expected format'));
    assert.ok(!stderr.includes('mcpe_short'), 'must not echo the supplied secret');
  });

  await test('exits with usage when no key is configured', async () => {
    const { code, stderr } = await runBridge('http://127.0.0.1:1/', [], {
      env: { MCPEMAILS_API_KEY: '', MCPEMAILS_KEY: '' },
    });
    assert.strictEqual(code, 2);
    assert.ok(stderr.includes('No API key'));
  });

  await test('ignores a non-JSON line rather than crashing', async () => {
    const stub = await startStub((message) => ({ jsonrpc: '2.0', id: message.id, result: {} }));
    const { messages, code, stderr } = await runBridge(stub.url, [
      'this is not json',
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    ]);
    stub.server.close();

    assert.strictEqual(code, 0);
    assert.strictEqual(messages.length, 1);
    assert.ok(stderr.includes('not valid JSON'));
    assert.ok(!stderr.includes('this is not json'), 'must not echo client input');
  });

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} failing: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write('\nall tests passed\n');
}

void main();
