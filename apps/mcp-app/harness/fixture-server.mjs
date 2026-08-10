#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Local development harness: a stateless MCP server that serves the review card
// and returns canned contract-shaped payloads.
//
// Deliberately mirrors the production edge function's shape: hand-rolled
// JSON-RPC over a single POST /mcp, no SDK, no session id, echoes
// protocolVersion 2025-06-18, and declares the `resources` capability (without
// it the host never wires resources/read — phase-0 Q5).
//
// This file is a test fixture. It is not shipped and knows nothing about auth.
//
//   node harness/fixture-server.mjs         # :3011/mcp
//
// Pair it with the ext-apps basic-host reference host (see run-host.sh).
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(here, "../dist/index.html");
const PORT = Number(process.env.FIXTURE_PORT ?? 3011);
const CARD_URI = "ui://mcpemails/review-card.html";
const MIME = "text/html;profile=mcp-app";
const PROTOCOL_VERSION = "2025-06-18";

const UI_META = {
  csp: {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  },
  prefersBorder: false,
};

// Fixture tools: name -> envelope. Model-visible so the host's picker offers
// them (the host filters visibility:["app"] out of the picker).
const FIXTURES = {
  fx_outbound_gmail: F.outboundGmail,
  fx_outbound_imap_truncated: F.outboundImapTruncated,
  fx_outbound_viewer_blocked: F.outboundViewerBlocked,
  fx_outbound_scheduled: F.outboundScheduled,
  fx_bulk_delete: F.bulkDelete,
  fx_bulk_move: F.bulkMove,
  fx_receipt_sent: F.receiptSent,
  fx_receipt_rejected: F.receiptRejected,
  fx_receipt_executed: F.receiptExecuted,
  fx_receipt_expired: F.receiptExpired,
  fx_receipt_failed: F.receiptFailed,
  fx_receipt_decided_elsewhere: F.receiptDecidedElsewhere,
  fx_unknown_version: F.unknownVersion,
  fx_malformed: F.malformed,
  // Not an envelope at all: what a UI-bearing tool returns for an inbox that
  // has not opted in, or for a non-plannable email_organize action. The card
  // must render NOTHING for this one. See fixtures.mjs#nonEnvelope.
  fx_non_envelope: F.nonEnvelope,
};

/**
 * Model-visible prose per fixture. Defaults to a description of the envelope;
 * the non-envelope fixture gets the text a real tool would return, because the
 * whole point of that case is that the host's own text result is what the user
 * should be left with.
 */
const PROSE = {
  // Faithful to `jsonOk` in the edge function, which mirrors the whole payload
  // into content[0].text. That matters: it exercises the card's text-fallback
  // parse branch (text starting with "{"), not just the structuredContent one.
  fx_non_envelope: JSON.stringify(F.nonEnvelope),
};

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

const fixtureTools = Object.keys(FIXTURES).map((name) => ({
  name,
  title: name,
  description: `Harness fixture: ${name}`,
  inputSchema: EMPTY_SCHEMA,
  _meta: { ui: { resourceUri: CARD_URI } },
}));

// The real card-called tools, app-only (contract §6). The harness does not
// enforce anything; it exists to exercise the card's call paths.
const appTools = [
  "approval_decide",
  "approval_update",
  "approval_schedule",
  "bulk_execute",
].map((name) => ({
  name,
  title: name,
  description: `Harness stub for ${name}`,
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
  _meta: { ui: { resourceUri: CARD_URI, visibility: ["app"] } },
}));

const ALL_TOOLS = [...fixtureTools, ...appTools];

function cardHtml() {
  if (!existsSync(BUNDLE)) {
    return "<!DOCTYPE html><html><body><p>bundle missing: run npm run build:bundle</p></body></html>";
  }
  // Read per request so a rebuild is picked up without restarting the harness.
  return readFileSync(BUNDLE, "utf8");
}

const ok = (id, result) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function envelopeResult(id, envelope, prose) {
  // Contract degradation rule: meaningful `content` prose always accompanies
  // `structuredContent`, so a non-UI client sees the same facts.
  return ok(id, {
    content: [{ type: "text", text: prose }],
    structuredContent: envelope,
  });
}

function handleToolsCall(req) {
  const { name, arguments: args = {} } = req.params ?? {};
  console.log(`[fixture] tools/call ${name}`, JSON.stringify(args));

  if (FIXTURES[name]) {
    const env = FIXTURES[name];
    return envelopeResult(
      id(req),
      env,
      PROSE[name] ?? `Fixture ${name} (${env.card ?? "not an envelope"}).`,
    );
  }

  switch (name) {
    case "approval_decide": {
      if (args.decision !== "reject") {
        // Server invariant from contract §6: approve is never accepted here.
        return fail(id(req), -32602, "approval_decide accepts reject only");
      }
      return envelopeResult(
        id(req),
        F.receiptRejected,
        "Rejected. Nothing was sent.",
      );
    }
    case "approval_update": {
      const base = F.outboundGmail;
      const next = {
        ...base,
        outbound: {
          ...base.outbound,
          subject: args.subject ?? base.outbound.subject,
          body: {
            ...base.outbound.body,
            text: args.body_text ?? base.outbound.body.text,
          },
        },
      };
      return envelopeResult(id(req), next, "Draft updated. Still pending approval.");
    }
    case "approval_schedule": {
      const base = F.outboundGmail;
      const next = {
        ...base,
        outbound: { ...base.outbound, send_at: args.send_at ?? null },
      };
      return envelopeResult(
        id(req),
        next,
        `Send time set to ${args.send_at}. Still pending approval.`,
      );
    }
    case "bulk_execute":
      return envelopeResult(
        id(req),
        F.receiptExecuted,
        "Moved 128 messages to Trash.",
      );
    default:
      return fail(id(req), -32602, `Unknown tool: ${name}`);
  }
}

const id = (req) => req.id;

function route(req) {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: { name: "mcp-emails-card-harness", version: "0.0.1" },
        instructions: "Local fixture harness for the review card.",
      });
    case "tools/list":
      return ok(req.id, { tools: ALL_TOOLS });
    case "prompts/list":
      return ok(req.id, { prompts: [] });
    case "resources/list":
      return ok(req.id, {
        resources: [
          {
            uri: CARD_URI,
            name: "review_card",
            description: "Outbound send / bulk plan review card",
            mimeType: MIME,
            _meta: { ui: UI_META },
          },
        ],
      });
    case "resources/templates/list":
      return ok(req.id, { resourceTemplates: [] });
    case "resources/read": {
      const uri = req.params?.uri;
      if (uri !== CARD_URI) return fail(req.id, -32602, `Unknown resource: ${uri}`);
      const html = cardHtml();
      console.log(`[fixture] resources/read ${uri} ${html.length} bytes`);
      return ok(req.id, {
        contents: [{ uri, mimeType: MIME, text: html, _meta: { ui: UI_META } }],
      });
    }
    case "tools/call":
      return handleToolsCall(req);
    case "ping":
      return ok(req.id, {});
    default:
      return fail(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id, accept",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, CORS).end();
    return;
  }
  if (!request.url?.startsWith("/mcp")) {
    response.writeHead(404, CORS).end("not found");
    return;
  }
  if (request.method !== "POST") {
    response
      .writeHead(405, { ...CORS, "content-type": "application/json" })
      .end(JSON.stringify(fail(null, -32601, "Only POST is supported")));
    return;
  }

  const chunks = [];
  request.on("data", (c) => chunks.push(c));
  request.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response
        .writeHead(400, { ...CORS, "content-type": "application/json" })
        .end(JSON.stringify(fail(null, -32700, "Parse error")));
      return;
    }
    if (body.id === undefined) {
      console.log(`[fixture] notification ${body.method}`);
      response.writeHead(202, CORS).end();
      return;
    }
    const result = route(body);
    response
      .writeHead(200, { ...CORS, "content-type": "application/json" })
      .end(JSON.stringify(result));
  });
}).listen(PORT, () => {
  console.log(`[fixture] http://localhost:${PORT}/mcp`);
  console.log(`[fixture] card bundle: ${BUNDLE}`);
  console.log(`[fixture] fixtures: ${Object.keys(FIXTURES).join(", ")}`);
});
