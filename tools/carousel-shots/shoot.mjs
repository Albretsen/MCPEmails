#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Captures the Claude directory carousel: the real in-chat cards (the built
// apps/mcp-app bundle) inside a minimal host, one PNG per card.
//
//   cd apps/mcp-app && npm run build:bundle      # builds dist/index.html
//   PLAYWRIGHT_DIR=<tools/video-studio/node_modules/playwright> \
//     node tools/carousel-shots/shoot.mjs [outDir]
//
// The host answers ui/initialize, then pushes ui/notifications/tool-input and
// ui/notifications/tool-result, the way Claude does. The envelopes mirror what
// supabase/functions/mcp-server really returns for each tool. All data is
// invented (the reviewer mailbox in scripts/seed-reviewer-mailbox.py, .example
// addresses). Nothing here calls production.
// ---------------------------------------------------------------------------
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const CARD = resolve(repo, "apps/mcp-app/dist/index.html");
const OUT = resolve(process.argv[2] ?? resolve(repo, "apps/web/public/directory/claude"));
const pw = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_DIR ?? resolve(repo, "tools/video-studio/node_modules/playwright"),
);

const V = "review-card-v1";
const NORA = "hello@harborknowledge.com";
const INBOX_ID = "6f0d3c1e-2a54-4b87-9d10-7a3e5c9b2f41";
const ELIN = "events@nordic-logistics-forum.example";
const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
const identity = {
  inbox_id: INBOX_ID,
  email_address: NORA,
  display_name: "Nora Lindqvist",
  provider: "imap",
  service: "migadu",
};

const REPLY_BODY =
  "Hi Elin,\n\nThank you for the invitation. I would be glad to speak at the Nordic " +
  "Logistics Forum in Bergen on 4 November, and the afternoon panel on port " +
  "throughput measurement suits me well.\n\nPlease send the programme details when " +
  "you have them.\n\nBest regards,\nNora\n\n" +
  "On Wed, 2 Sep 2026 09:00:00 +0200, Nordic Logistics Forum <events@nordic-logistics-forum.example> wrote:\n" +
  "> Dear Nora,\n>\n" +
  "> We would like to invite you to speak at the Nordic Logistics Forum in\n" +
  "> Bergen on 4 November. The slot is 25 minutes plus questions, on the\n" +
  "> afternoon panel about port throughput measurement.\n>\n" +
  "> Could you let us know by 20 September whether you are able to join?\n>\n" +
  "> Warm regards,\n> Elin Kvamme\n> Programme Committee";

// The server marks where the quoted original starts, in lines (quoted-reply.ts#quotedTextLine).
const QUOTED = { line: REPLY_BODY.slice(0, REPLY_BODY.indexOf("On Wed,")).split("\n").length - 1 };

// draft{action:"reply"}: deferred body (review-card-v2) with the text in result _meta.
const DRAFT = {
  scene: "draft",
  input: { action: "reply", message_id: "INBOX:14", body: REPLY_BODY },
  result: {
    structuredContent: {
      draft_id: "Drafts:3",
      inbox_id: INBOX_ID,
      threaded: true,
      schema_version: "review-card-v2",
      card: "draft_editor",
      state: "editing",
      dashboard_url: "https://mcpemails.com/dashboard",
      provider: { label: "IMAP + SMTP", route: "Saved to your Drafts folder", caveats: [] },
      actor: { can_edit: true, reason: null },
      draft: {
        draft_id: "Drafts:3",
        id_is_stable: false,
        origin: "reply",
        version: "v1:reviewer-elin-reply",
        last_saved_at: iso(-1),
        last_saved_by: "agent",
        identity,
        recipients: { to: [ELIN], cc: [], bcc: [] },
        subject: "Re: Speaker invitation: Nordic Logistics Forum, 4 November",
        body: { text: null, html: null, truncated: false, deferred: true, quoted: QUOTED },
        attachments: [],
        signature: { embedded: false },
        in_reply_to: {
          message_id: "INBOX:14",
          subject: "Speaker invitation: Nordic Logistics Forum, 4 November",
          from: "Nordic Logistics Forum <events@nordic-logistics-forum.example>",
          date: "2026-09-02T09:00:00Z",
        },
        can_send: true,
      },
    },
    _meta: { "mcpemails/draft_body": { text: REPLY_BODY, html: null, truncated: false, quoted: QUOTED } },
  },
};

// email_compose{action:"send"} on an inbox that holds sends: pending_approval merged with the envelope.
const APPROVAL_ID = "3b7e91c2-5d04-4f68-a1c3-8e2f6d0b9a57";
const NOTE_BODY =
  "Hi Elin,\n\nThank you for the invitation to the Nordic Logistics Forum on 4 November. " +
  "I will confirm my attendance shortly.\n\nBest regards,\nNora Lindqvist";
const HELD = {
  scene: "held",
  input: { to: ELIN, subject: "Thank you for the invitation", body: NOTE_BODY },
  result: {
    structuredContent: {
      status: "pending_approval",
      approval_id: APPROVAL_ID,
      inbox_id: INBOX_ID,
      review_url: `https://mcpemails.com/approvals/${APPROVAL_ID}`,
      message: "This email has not been sent. It is waiting for a person to approve it.",
      schema_version: V,
      card: "outbound_review",
      state: "pending",
      dashboard_url: "https://mcpemails.com/dashboard/approvals",
      provider: {
        label: "IMAP + SMTP",
        route: "SMTP submission · smtp.migadu.com:465",
        caveats: [
          "SMTP submission does not itself file a copy in Sent; the server appends one over IMAP where the account allows it.",
        ],
      },
      actor: { can_decide: true, reason: null },
      outbound: {
        approval_id: APPROVAL_ID,
        operation: "email_send",
        created_at: iso(-1),
        expires_at: iso(60 * 24 * 2),
        send_at: null,
        review_url: `https://mcpemails.com/approvals/${APPROVAL_ID}`,
        identity,
        recipients: { to: [ELIN], cc: [], bcc_count: 0 },
        subject: "Thank you for the invitation",
        body: { text: NOTE_BODY, html: null, truncated: false },
        attachments: [],
        signature: { will_append: false, source: null, preview_text: null },
        requested_by: { api_key_name: "Claude", client_name: "claude-ai" },
      },
    },
  },
};

// automation{action:"create"}: the model's plain row. The card then asks card_automation for the rest.
const RULE_ID = "9a4c2e17-6b3d-4f05-8c91-d27e5b0a4f63";
const AUTOMATION = {
  scene: "automation",
  input: { action: "create" },
  result: {
    content: [{ type: "text", text: "{}" }],
    structuredContent: { automation: { id: RULE_ID, name: "DevWeekly to Archive", enabled: false } },
  },
  tools: {
    card_automation: {
      structuredContent: {
        schema_version: V,
        card: "automation",
        state: "pending",
        automation: {
          id: RULE_ID,
          name: "DevWeekly to Archive",
          enabled: false,
          // automationSentence() for a move rule with interval_minutes 1440
          sentence: "Move mail from news@devweekly.example to Archive, every day.",
          inbox: NORA,
          note: null,
          matched: 1,
          capped: false,
          matches: [
            { from: "DevWeekly <news@devweekly.example>", subject: "DevWeekly #212: the quiet return of batch processing" },
          ],
        },
      },
    },
  },
};

// email_organize{action:"move_batch"} on IMAP: the receipt with Undo and the sample in result _meta.
const BULK = {
  scene: "bulk",
  input: { action: "move_batch", destination: "Archive" },
  result: {
    structuredContent: {
      schema_version: V,
      card: "receipt",
      dashboard_url: "https://mcpemails.com/dashboard",
      state: "executed",
      receipt: {
        outcome: "executed",
        headline: "Moved 2 messages from Inbox to Archive",
        detail: "",
        affected_count: 2,
        dashboard_url: "https://mcpemails.com/dashboard",
        error_code: null,
      },
      undo: { undo_id: "c51e08b4-7d2a-4396-b0f8-3a9e1d6c7b25", expires_at: iso(60 * 24) },
    },
    _meta: {
      "mcpemails/bulk_sample": [
        { from: "DevWeekly <news@devweekly.example>", subject: "DevWeekly #212: the quiet return of batch processing" },
        { from: "Saltline Freight Operations <ops@saltline-freight.example>", subject: "Delay notice: container MSKU4417" },
      ],
    },
  },
};

// draft_read: v1, body inline, same version, origin "read", no in_reply_to (what the server returns).
DRAFT.tools = {
  draft_read: {
    structuredContent: {
      ...DRAFT.result.structuredContent,
      schema_version: V,
      draft: {
        ...DRAFT.result.structuredContent.draft,
        origin: "read",
        in_reply_to: null,
        body: { text: REPLY_BODY, html: null, truncated: false, quoted: QUOTED },
      },
    },
  },
};

const SCENES = { draft: DRAFT, held: HELD, automation: AUTOMATION, bulk: BULK };

const HOST = `<!doctype html><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;background:#fff}#f{display:block;width:700px;height:1400px;border:0}</style>
<iframe id="f" src="/card.html"></iframe>
<script type="module">
const scene = await (await fetch("/scene.json?name=" + new URLSearchParams(location.search).get("scene"))).json();
const f = document.getElementById("f");
const post = (m) => f.contentWindow.postMessage(m, "*");
window.__ready = false;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize") {
    post({ jsonrpc: "2.0", id: m.id, result: {
      protocolVersion: "2026-01-26", hostInfo: { name: "shot-host", version: "1" },
      hostCapabilities: { openLinks: {}, updateModelContext: {}, serverTools: {} },
      hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"] } } });
    setTimeout(() => {
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: scene.input } });
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "ok" }], ...scene.result } });
    }, 80);
    return;
  }
  if (m.method === "ui/notifications/size-changed") {
    window.__ready = true;
    return;
  }
  if (m.method === "tools/call" && m.id !== undefined) {
    const t = scene.tools?.[m.params?.name];
    post(t ? { jsonrpc: "2.0", id: m.id, result: t } : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "not available in this host" } });
    return;
  }
  if (m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
});
</script>`;

const server = createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/card.html") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(CARD));
  if (u.pathname === "/scene.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(SCENES[u.searchParams.get("name")]));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HOST);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

mkdirSync(OUT, { recursive: true });
const browser = await pw.chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);
const ctx = await browser.newContext({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const names = { draft: "draft-editor", held: "held-send-review", automation: "automation", bulk: "bulk-move-receipt" };
for (const [scene, file] of Object.entries(names)) {
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.error(`[${scene}]`, m.text()));
  await page.goto(`${base}/?scene=${scene}`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 8000 });
  const frame = page.frameLocator("#f");
  if (scene === "draft") await frame.getByText("Show quote").click();
  if (scene === "bulk") await frame.locator("details summary").click();
  await page.waitForTimeout(700);
  // The card's real height after any expansion, then shoot the frame alone.
  const h = await frame.locator("html").evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
  await page.evaluate((h) => (document.getElementById("f").style.height = h + "px"), h);
  await page.waitForTimeout(200);
  await page.locator("#f").screenshot({ path: `${OUT}/${file}.png` });
  console.log(scene, "->", `${OUT}/${file}.png`);
  await page.close();
}
await browser.close();
server.close();
