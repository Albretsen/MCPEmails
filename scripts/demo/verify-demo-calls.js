#!/usr/bin/env node
/**
 * Rehearse every tool call the demo video depends on, against the real
 * production MCP server, before anyone starts recording.
 *
 * This exists because a production audit on 2026-08-19 found that most of the
 * tool surface has no evidence of ever having worked. Over the preceding 14
 * days: inbox_list 10442 ok / 18 err, email_read 671/166, contact_search 67/2,
 * and email_compose 0 ok / 29 err. email_organize, draft, folder and schedule
 * had no successful calls at all, because nobody had tried them.
 *
 * "Nobody tried it" and "it works" look identical in a dashboard and very
 * different on camera. So every beat gets rehearsed here first.
 *
 * Usage:
 *   MCP_API_KEY=mcpe_live_... node scripts/demo/verify-demo-calls.js
 *   MCP_API_KEY=mcpe_live_... node scripts/demo/verify-demo-calls.js --write
 *
 * Without --write only read-only calls run. --write additionally exercises the
 * mutating beats (move, draft, reply) and is safe ONLY against the throwaway
 * demo mailbox seeded by demo-mailbox.js. Never point --write at a real inbox.
 */

const ENDPOINT = process.env.MCP_ENDPOINT || "https://mcpemails.com/api/mcp";
const KEY = process.env.MCP_API_KEY;
const WRITE = process.argv.includes("--write");

if (!KEY) {
  console.error("Set MCP_API_KEY to a scoped key from the dashboard.");
  process.exit(1);
}

let requestId = 0;

async function call(method, params) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${KEY}`,
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });

  const text = await res.text();
  // The server may answer as SSE; pull the JSON payload out either way.
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const body = JSON.parse(line ? line.slice(5).trim() : text);

  if (body.error) return { ok: false, kind: "protocol", detail: body.error };
  if (body.result?.isError) {
    const t = (body.result.content || []).map((c) => c.text || "").join(" ");
    return { ok: false, kind: "tool", detail: t.slice(0, 300) };
  }
  return { ok: true, result: body.result };
}

async function tool(name, args) {
  return call("tools/call", { name, arguments: args });
}

const results = [];
function record(beat, label, outcome) {
  results.push({ beat, label, ...outcome });
  const mark = outcome.ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${label}`);
  if (!outcome.ok) console.log(`         ${outcome.kind}: ${JSON.stringify(outcome.detail).slice(0, 240)}`);
}

async function main() {
  console.log(`Rehearsing demo calls against ${ENDPOINT}\n`);

  console.log("Beat 1 - inbox discovery (the cold open)");
  const inboxes = await tool("inbox_list", {});
  record(1, "inbox_list with no arguments", inboxes);
  if (!inboxes.ok) {
    console.log("\nCannot continue without inbox_list. Check the key's scopes.");
    return summary();
  }

  const parsed = inboxes.result?.structuredContent?.inboxes
    || JSON.parse((inboxes.result?.content?.[0]?.text || "{}")).inboxes
    || [];
  const list = Array.isArray(parsed) ? parsed : [];
  console.log(`         ${list.length} inbox(es): ${list.map((i) => `${i.email_address} (${i.provider})`).join(", ")}`);

  const imap = list.find((i) => i.provider === "imap" || i.provider === "fastmail");
  const target = imap || list[0];
  if (!target) {
    console.log("\nNo inbox connected. Connect the demo mailbox first.");
    return summary();
  }
  const inbox_id = target.inbox_id;
  console.log(`         filming against: ${target.email_address} (${target.provider})\n`);

  // The multi-inbox wedge only reads as a wedge if there is more than one.
  if (list.length < 2) {
    console.log("  NOTE: only one inbox is connected. The multi-inbox beat (4) will not");
    console.log("        demonstrate anything. Connect a second inbox before filming.\n");
  }

  console.log("Beat 2 - reading the IMAP inbox");
  const listed = await tool("email_read", { action: "list", inbox_id, limit: 10 });
  record(2, "email_read action=list, limit 10", listed);

  let messageId = null;
  if (listed.ok) {
    const txt = listed.result?.content?.[0]?.text || "";
    const m = txt.match(/"(?:message_id|id)"\s*:\s*"([^"]+)"/);
    messageId = m ? m[1] : null;
    console.log(`         first message_id: ${messageId || "could not parse"}`);
  }

  if (messageId) {
    const read = await tool("email_read", { action: "read", inbox_id, message_id: messageId });
    record(2, "email_read action=read on that message_id", read);
  }

  console.log("\nBeat 3 - search (the known-broken date filter)");
  // Documented example format, from the tool's own description. Expected to fail.
  const badDate = await tool("email_read", { action: "search", inbox_id, since: "2026-08-01", limit: 5 });
  record(3, 'search since="2026-08-01"  (the DOCUMENTED example format)', badDate);
  if (!badDate.ok) console.log("         ^ expected: schema wants a timezone suffix. Do not film this.");

  const goodDate = await tool("email_read", { action: "search", inbox_id, since: "2026-08-01T00:00:00Z", limit: 5 });
  record(3, 'search since="2026-08-01T00:00:00Z"  (the format that works)', goodDate);

  const textSearch = await tool("email_read", { action: "search", inbox_id, text: "invoice", limit: 5 });
  record(3, 'search text="invoice"  (no date filter, safest on camera)', textSearch);

  console.log("\nBeat 4 - multi-inbox (contact_search spans every inbox when inbox_id is omitted)");
  const contacts = await tool("contact_search", { query: "priya" });
  record(4, "contact_search with inbox_id omitted", contacts);

  console.log("\nBeat 5 - folders");
  const folders = await tool("folder", { action: "list", inbox_id });
  record(5, "folder action=list", folders);

  console.log("\nBeat 6 - the workflow prompt used in the triage beat");
  const prompts = await call("prompts/list", {});
  record(6, "prompts/list", prompts);
  if (prompts.ok) {
    const names = (prompts.result?.prompts || []).map((p) => p.name);
    console.log(`         ${names.length} prompt(s): ${names.join(", ")}`);
    if (!names.includes("morning_inbox_triage")) {
      console.log("         WARNING: morning_inbox_triage not offered to this key (scope-filtered).");
    }
  }

  if (!WRITE) {
    console.log("\nSkipping mutating beats. Re-run with --write against the demo mailbox");
    console.log("to rehearse move, draft and reply.");
    return summary();
  }

  console.log("\nBeat 7 - mutating calls (--write, demo mailbox only)");

  const created = await tool("folder", { action: "create", inbox_id, name: "Demo-Triage" });
  record(7, 'folder action=create name="Demo-Triage"', created);

  if (messageId && created.ok) {
    const folderList = await tool("folder", { action: "list", inbox_id });
    const ftxt = folderList.result?.content?.[0]?.text || "";
    const fm = ftxt.match(/"folder_id"\s*:\s*"([^"]*Demo-Triage[^"]*)"/i)
      || ftxt.match(/"(?:folder_id|id)"\s*:\s*"([^"]+)"[^}]*"name"\s*:\s*"Demo-Triage"/i);
    const destination_folder_id = fm ? fm[1] : "Demo-Triage";
    const moved = await tool("email_organize", {
      action: "move", inbox_id, message_id: messageId, destination_folder_id,
    });
    record(7, "email_organize action=move", moved);
  }

  const draft = await tool("draft", {
    action: "create", inbox_id,
    subject: "Demo draft", body: "Checking that drafts work before filming.",
    to: ["someone@harborline.example"],
  });
  record(7, "draft action=create", draft);

  // The known-bad shape: a reply that also carries subject/to. This is what a
  // model naturally produces, and it is a hard schema rejection.
  if (messageId) {
    const badReply = await tool("email_compose", {
      action: "reply", inbox_id, message_id: messageId,
      subject: "Re: test", body: "Thanks, confirmed.",
    });
    record(7, "email_compose action=reply WITH subject  (the natural shape)", badReply);
    if (!badReply.ok) console.log("         ^ expected to fail: reply forbids subject/to/cc/bcc/reply_to.");

    const goodReply = await tool("email_compose", {
      action: "reply", inbox_id, message_id: messageId, body: "Thanks, confirmed.",
    });
    record(7, "email_compose action=reply, body only  (the only shape that can pass)", goodReply);
  }

  return summary();
}

function summary() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed, out of ${results.length} rehearsed calls.`);
  if (fail) {
    console.log("\nFailing calls - do NOT put these on camera:");
    for (const r of results.filter((x) => !x.ok)) console.log(`  beat ${r.beat}: ${r.label}`);
  }
  console.log("\nFilm only the beats that passed.");
  process.exitCode = 0;
}

main().catch((e) => {
  console.error("Harness error:", e.message);
  process.exit(1);
});
