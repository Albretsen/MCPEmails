#!/usr/bin/env node
/**
 * mcpemails - stdio bridge to the hosted MCP Emails server.
 *
 * Many MCP clients (Claude Desktop, Cursor, Cline, Windsurf) can only launch a
 * local subprocess and talk JSON-RPC over stdin/stdout. MCP Emails is a hosted
 * server that speaks JSON-RPC over HTTPS. This bridge sits between the two and
 * does nothing else: every message read from stdin is POSTed verbatim to the
 * server, and every response is written back to stdout verbatim.
 *
 * Deliberate non-goals, because a bridge that edits the protocol is a bridge
 * that breaks whenever either side gains a feature:
 *   - It does not synthesise, rewrite, filter or reorder JSON-RPC messages.
 *   - It does not implement initialize, tools/list or any other method itself.
 *   - It adds no fields to requests and strips none from responses.
 * The only message this process ever authors is a JSON-RPC error reply for a
 * request whose HTTP call failed, because the alternative is a client that
 * hangs forever waiting on an id that will never come back.
 *
 * The API key is read from the environment or a CLI flag, sent only in the
 * Authorization header to the configured MCP Emails endpoint, and never
 * written to disk, to stdout, or to the diagnostic log on stderr.
 *
 * Requires Node 18+ for global fetch. No dependencies.
 */

'use strict';

const PACKAGE_VERSION = require('../package.json').version;

const DEFAULT_ENDPOINT = 'https://mcpemails.com/api/mcp';

// Keys are "mcpe_" plus 64 hex characters. Validating the shape locally turns
// the most common misconfiguration (a truncated paste, or the dashboard's
// display prefix copied instead of the key) into an immediate, readable error
// on stderr rather than an opaque 401 surfaced through the client's UI.
const KEY_PATTERN = /^mcpe_[0-9a-f]{64}$/;

const USAGE = `mcpemails ${PACKAGE_VERSION}

  Bridges a stdio MCP client to the hosted MCP Emails server.

Usage
  npx -y mcpemails [options]

Options
  --key <mcpe_...>   API key. Prefer the environment variable below.
  --url <url>        Server endpoint (default: ${DEFAULT_ENDPOINT}).
                     Point this at your own deployment when self-hosting.
  --verbose          Log request/response diagnostics to stderr.
  --version          Print the version and exit.
  --help             Print this help and exit.

Environment
  MCPEMAILS_API_KEY  API key. Recommended over --key: process arguments are
                     visible to other processes on the machine.
  MCPEMAILS_URL      Server endpoint.

Get a key at https://mcpemails.com/dashboard/keys
`;

/** Parse argv. Unknown flags are rejected rather than ignored, so a typo in a
 *  client config surfaces as an error instead of silently doing nothing. */
function parseArgs(argv) {
  const options = { key: null, url: null, verbose: false, help: false, version: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const inlineValue = arg.startsWith('--') && eq !== -1 ? arg.slice(eq + 1) : null;
    const takeValue = () => {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new Error(`Option ${name} requires a value.`);
      return argv[i];
    };

    switch (name) {
      case '--key':
      case '--api-key':
        options.key = takeValue();
        break;
      case '--url':
      case '--endpoint':
        options.url = takeValue();
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--version':
      case '-v':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return options;
}

/**
 * Write one line to stderr.
 *
 * stderr, never stdout: stdout is the JSON-RPC channel and any stray byte on it
 * corrupts the stream for the client. Callers must never pass the API key or a
 * message body here; bodies can contain email content and recipients.
 */
function log(message) {
  process.stderr.write(`[mcpemails] ${message}\n`);
}

/**
 * Serialise writes to stdout.
 *
 * Requests are dispatched concurrently, so several responses can be ready at
 * once. Interleaved partial writes would corrupt the newline framing, so every
 * message is appended to a queue and flushed one at a time, respecting the
 * backpressure signal from process.stdout.
 */
function createStdoutWriter() {
  const queue = [];
  let writing = false;

  function flush() {
    if (writing) return;
    const chunk = queue.shift();
    if (chunk === undefined) return;
    writing = true;
    const drained = process.stdout.write(chunk, () => {
      writing = false;
      flush();
    });
    // The callback fires on flush regardless of the return value, so `drained`
    // is only informational here; keeping the branch explicit documents that
    // backpressure is handled by waiting for the callback rather than ignored.
    if (!drained) return;
  }

  return function write(message) {
    queue.push(`${JSON.stringify(message)}\n`);
    flush();
  };
}

/**
 * Extract the JSON-RPC payload from an HTTP response.
 *
 * The hosted server answers with a single `application/json` document today.
 * The MCP Streamable HTTP transport also permits `text/event-stream`, so the
 * SSE branch exists to keep this bridge working unchanged if the server starts
 * streaming: each `data:` field of an SSE response carries one JSON-RPC
 * message, and all of them are returned in order.
 *
 * Returns an array of messages to forward, which is empty for a response with
 * no body (a notification acknowledgement).
 */
async function readMessages(response) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();
  if (!text.trim()) return [];

  if (contentType.includes('text/event-stream')) {
    const messages = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        throw new Error('Server sent an SSE event that is not valid JSON.');
      }
    }
    return messages;
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // A non-JSON body is almost always an infrastructure error page (a proxy
    // 502, a captive portal). Surfacing a truncated excerpt makes that
    // diagnosable without dumping a full HTML page into the client's log.
    throw new Error(
      `Server returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`
    );
  }
}

/** Collect every JSON-RPC id in a message or batch, so a transport failure can
 *  be answered for each in-flight request instead of leaving the client hung. */
function idsOf(message) {
  const items = Array.isArray(message) ? message : [message];
  return items
    .filter((item) => item && typeof item === 'object' && item.id !== undefined && item.id !== null)
    .map((item) => item.id);
}

/** Human-readable method name for a message or batch, for stderr only. */
function methodOf(message) {
  const items = Array.isArray(message) ? message : [message];
  const methods = items.map((item) => (item && item.method) || '?');
  return methods.join(', ');
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (options.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (options.version) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    process.exit(0);
  }

  const apiKey = options.key || process.env.MCPEMAILS_API_KEY || process.env.MCPEMAILS_KEY;
  if (!apiKey) {
    process.stderr.write(
      'No API key. Set MCPEMAILS_API_KEY or pass --key.\n' +
        'Create one at https://mcpemails.com/dashboard/keys\n\n' +
        USAGE
    );
    process.exit(2);
  }
  if (!KEY_PATTERN.test(apiKey)) {
    // The key itself is never echoed, only its shape, so a copy-paste mistake
    // is diagnosable without the secret reaching a log file.
    process.stderr.write(
      'The API key is not in the expected format (mcpe_ followed by 64 hex characters).\n' +
        `Received a ${apiKey.length}-character value. Copy the full key from ` +
        'https://mcpemails.com/dashboard/keys\n'
    );
    process.exit(2);
  }

  const endpoint = options.url || process.env.MCPEMAILS_URL || DEFAULT_ENDPOINT;
  const write = createStdoutWriter();

  if (typeof fetch !== 'function') {
    process.stderr.write(
      `Node ${process.versions.node} has no global fetch. mcpemails needs Node 18 or newer.\n`
    );
    process.exit(1);
  }

  // The protocol version the client and server settled on during initialize.
  // MCP requires it on subsequent HTTP requests, and it is observed rather than
  // chosen here so the bridge never pins a version of its own.
  let negotiatedProtocolVersion = null;

  let inFlight = 0;
  let stdinEnded = false;

  // Exit only once stdin has closed AND every forwarded request has been
  // answered. Exiting on stdin close alone would drop responses to calls that
  // are still running, which for a slow mailbox operation is a real risk.
  function maybeExit() {
    if (stdinEnded && inFlight === 0) process.exit(0);
  }

  async function forward(message) {
    const ids = idsOf(message);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': `mcpemails-stdio-bridge/${PACKAGE_VERSION} node/${process.versions.node}`,
    };
    if (negotiatedProtocolVersion) {
      headers['MCP-Protocol-Version'] = negotiatedProtocolVersion;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });

      if (options.verbose) {
        log(`${methodOf(message)} -> HTTP ${response.status}`);
      }

      const replies = await readMessages(response);
      for (const reply of replies) {
        // Learn the negotiated version from the server's own answer rather than
        // asserting one. Anything the client sends afterwards carries it.
        if (reply && reply.result && typeof reply.result.protocolVersion === 'string') {
          negotiatedProtocolVersion = reply.result.protocolVersion;
        }
        write(reply);
      }

      // A request that produced no reply at all would hang the client forever,
      // so an empty body for a message carrying an id is reported as an error.
      // An empty body for a notification is correct and stays silent.
      if (replies.length === 0 && ids.length > 0) {
        for (const id of ids) {
          write({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: `MCP Emails returned HTTP ${response.status} with no response body.`,
            },
          });
        }
      }
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      if (options.verbose) log(`${methodOf(message)} failed: ${detail}`);
      for (const id of ids) {
        write({
          jsonrpc: '2.0',
          id,
          // -32603 Internal error: the request was well-formed and the failure
          // is on the transport, which is exactly what the client should retry.
          error: { code: -32603, message: `Could not reach MCP Emails: ${detail}` },
        });
      }
      // A failed notification has no id to answer on. Report it on stderr so it
      // is visible in the client's log rather than vanishing.
      if (ids.length === 0) log(`Dropped notification (${methodOf(message)}): ${detail}`);
    } finally {
      inFlight -= 1;
      maybeExit();
    }
  }

  // MCP stdio framing: one JSON message per line, UTF-8, no embedded newlines.
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.trim()) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Never echo the line: a malformed frame can still contain message
        // content. The client owns the framing bug, so report and move on.
        log('Ignored a line from the client that is not valid JSON.');
        continue;
      }
      inFlight += 1;
      void forward(message);
    }
  });

  process.stdin.on('end', () => {
    stdinEnded = true;
    maybeExit();
  });

  // A client that disappears closes the pipe. Writing to it then raises EPIPE,
  // which must not print a Node stack trace into the client's log.
  process.stdout.on('error', (error) => {
    if (error && error.code === 'EPIPE') process.exit(0);
    log(`stdout error: ${error && error.message}`);
    process.exit(1);
  });

  if (options.verbose) log(`bridging stdio to ${endpoint}`);
}

main();
