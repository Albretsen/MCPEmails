// ---------------------------------------------------------------------------
// outlook-graph.test.ts — request shapes for the Microsoft Graph transport.
//
// The Outlook connector had never run against real Graph when these were
// written (zero Outlook inboxes in prod), so these tests are the only thing
// standing between a Graph rule and a 400 in front of the first user. Each one
// stubs `globalThis.fetch`, drives a helper from outlook-graph.ts, and asserts
// what went over the wire: URL, method, headers, body. See the header of
// outlook-graph.ts for the audit that produced each rule and its doc source.
//
// Run: deno test --node-modules-dir=none --allow-read --allow-env supabase/functions/mcp-server/outlook-graph.test.ts
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DEFAULT_GRAPH_RETRY,
  freshOutlookAccessToken,
  GRAPH_BASE,
  GRAPH_EPOCH_FILTER,
  graphAddAttachments,
  graphErrorFromResponse,
  graphFetch,
  graphFilterForDateOrder,
  graphListAttachmentMeta,
  graphPrepareResponseDraft,
  graphSearchParam,
  graphSendDraft,
  graphUploadLargeAttachment,
  IMMUTABLE_ID_PREFER,
  listOutlookFolderTree,
  mergeResponseBody,
  needsDraftUpload,
  OutlookGraphError,
  outlookAuthority,
  outlookFolderReferences,
  type OutlookTokenDeps,
  type OutlookTokenRow,
  parseRetryAfterMs,
  resetOutlookTokenStateForTests,
  resolveOutlookArchiveFolderId,
  setGraphSleepForTests,
} from "./outlook-graph.ts";

// ── fetch stub ──────────────────────────────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

type Responder = (call: Call) => Response | Promise<Response>;

/**
 * Replace globalThis.fetch for the duration of `run`. `responders` answer the
 * calls in order; a function answers every remaining call.
 */
async function withFetch(
  responders: Responder[] | Responder,
  run: (calls: Call[]) => Promise<void>,
): Promise<Call[]> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  setGraphSleepForTests((ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    let body: string | Uint8Array | null = null;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
    else if (init?.body instanceof Uint8Array) body = init.body;
    else if (init?.body instanceof URLSearchParams) body = init.body.toString();
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body };
    calls.push(call);
    const responder = Array.isArray(responders) ? responders[calls.length - 1] : responders;
    if (!responder) throw new Error(`unexpected fetch #${calls.length}: ${call.method} ${call.url}`);
    return await responder(call);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
    setGraphSleepForTests(null);
  }
  (calls as Call[] & { sleeps?: number[] }).sleeps = sleeps;
  return calls;
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const empty = (status: number, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers });

const bodyJson = (c: Call) => JSON.parse(c.body as string);

// ── graphFetch: auth, Prefer, URL ────────────────────────────────────────────

Deno.test("graphFetch sends bearer auth and Prefer: IdType=\"ImmutableId\" on every call", async () => {
  const calls = await withFetch([() => json(200, {})], async () => {
    await graphFetch("tok", "/me/messages?$top=1", { prefer: ['outlook.body-content-type="text"'] });
  });
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages?$top=1`);
  assertEquals(calls[0].headers["authorization"], "Bearer tok");
  assertStringIncludes(calls[0].headers["prefer"], IMMUTABLE_ID_PREFER);
  assertStringIncludes(calls[0].headers["prefer"], 'outlook.body-content-type="text"');
});

Deno.test("graphFetch follows an absolute @odata.nextLink unchanged", async () => {
  const next = "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=abc";
  const calls = await withFetch([() => json(200, {})], async () => {
    await graphFetch("tok", next);
  });
  assertEquals(calls[0].url, next);
});

// ── Retry-After ──────────────────────────────────────────────────────────────

Deno.test("a 429 with Retry-After is retried after the asked wait", async () => {
  let status = 0;
  const calls = await withFetch(
    [() => json(429, { error: { code: "TooManyRequests" } }, { "Retry-After": "2" }), () => json(200, { ok: 1 })],
    async () => {
      status = (await graphFetch("tok", "/me/messages")).status;
    },
  );
  assertEquals(status, 200);
  assertEquals(calls.length, 2);
  assertEquals((calls as Call[] & { sleeps: number[] }).sleeps, [2000]);
});

Deno.test("503 is retried too, at most maxRetries times, then the failure is returned", async () => {
  let status = 0;
  const calls = await withFetch(() => empty(503, { "Retry-After": "1" }), async () => {
    status = (await graphFetch("tok", "/me/messages")).status;
  });
  assertEquals(status, 503);
  assertEquals(calls.length, DEFAULT_GRAPH_RETRY.maxRetries + 1);
});

Deno.test("a Retry-After longer than the budget is not waited out", async () => {
  let status = 0;
  const calls = await withFetch(() => empty(429, { "Retry-After": "60" }), async () => {
    status = (await graphFetch("tok", "/me/messages")).status;
  });
  assertEquals(status, 429, "the throttle is reported, not slept through");
  assertEquals(calls.length, 1);
});

Deno.test("504 is never retried: the work may have happened", async () => {
  const calls = await withFetch(() => empty(504), async () => {
    await graphFetch("tok", "/me/sendMail", { method: "POST", body: "{}" });
  });
  assertEquals(calls.length, 1);
});

Deno.test("Retry-After parses both delta-seconds and an HTTP date", () => {
  assertEquals(parseRetryAfterMs("3"), 3000);
  assertEquals(parseRetryAfterMs(null), null);
  const now = Date.parse("2026-09-25T10:00:00Z");
  assertEquals(parseRetryAfterMs("Fri, 25 Sep 2026 10:00:04 GMT", now), 4000);
});

// ── Error mapping: only 401 means reconnect ─────────────────────────────────

Deno.test("401 maps to outlook_auth_failed; 403 is a permission error, not a reconnect", async () => {
  const e401 = await graphErrorFromResponse(empty(401), "Outlook move");
  assertEquals(e401.message, "outlook_auth_failed");

  const e403 = await graphErrorFromResponse(
    json(403, { error: { code: "ErrorAccessDenied", message: "Access is denied." } }),
    "Outlook move",
  );
  assert(e403 instanceof OutlookGraphError);
  assertEquals(e403.status, 403);
  assertEquals(e403.code, "ErrorAccessDenied");
  assert(e403.message !== "outlook_auth_failed");
  assertStringIncludes(e403.message, "error 403 (ErrorAccessDenied)");
  assertStringIncludes(e403.message, "Access is denied.");
  assertStringIncludes(e403.message, "not an expired sign-in");
});

Deno.test("a missing folder reads as 'does not exist' so the folder_missing classifiers catch it", async () => {
  const e = await graphErrorFromResponse(
    json(404, { error: { code: "ErrorFolderNotFound", message: "The specified folder could not be found in the store." } }),
    "Outlook list messages",
  );
  assertStringIncludes(e.message, "does not exist");
});

// ── $filter + $orderby ───────────────────────────────────────────────────────

Deno.test("an $orderby=receivedDateTime filter leads with receivedDateTime (InefficientFilter)", () => {
  assertEquals(graphFilterForDateOrder("isRead eq false"), `${GRAPH_EPOCH_FILTER} and isRead eq false`);
  assertEquals(
    graphFilterForDateOrder("isRead eq false and hasAttachments eq true and receivedDateTime ge 2026-08-01T00:00:00Z"),
    "receivedDateTime ge 2026-08-01T00:00:00Z and isRead eq false and hasAttachments eq true",
  );
  assertEquals(graphFilterForDateOrder(""), GRAPH_EPOCH_FILTER);
});

Deno.test("$search is the whole KQL in one pair of quotes", () => {
  assertEquals(graphSearchParam('from:alice subject:"q3 report"'), '"from:alice subject:\\"q3 report\\""');
});

// ── Token refresh ────────────────────────────────────────────────────────────

function tokenDeps(over: Partial<OutlookTokenDeps> = {}) {
  const persisted: { id: string; patch: Partial<OutlookTokenRow> }[] = [];
  const revoked: string[] = [];
  const deps: OutlookTokenDeps = {
    clientId: "cid",
    clientSecret: "secret",
    decrypt: (s) => Promise.resolve(s.replace(/^enc:/, "")),
    encrypt: (s) => Promise.resolve(`enc:${s}`),
    persist: (id, patch) => {
      persisted.push({ id, patch });
      return Promise.resolve();
    },
    markRevoked: (id) => {
      revoked.push(id);
      return Promise.resolve();
    },
    refreshThresholdMs: 5 * 60_000,
    now: () => Date.parse("2026-09-25T10:00:00Z"),
    ...over,
  };
  return { deps, persisted, revoked };
}

const expiredRow = (): OutlookTokenRow => ({
  id: "inbox-1",
  oauth_access_token: "enc:old-access",
  oauth_refresh_token: "enc:old-refresh",
  oauth_token_expires_at: "2026-09-25T09:00:00Z",
});

Deno.test("a refresh persists the ROTATED refresh token and updates the in-memory row", async () => {
  resetOutlookTokenStateForTests();
  const { deps, persisted } = tokenDeps();
  const row = expiredRow();
  let token = "";
  const calls = await withFetch(
    [() => json(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })],
    async () => {
      token = await freshOutlookAccessToken(row, deps);
    },
  );
  assertEquals(token, "new-access");
  assertEquals(calls[0].url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
  const form = new URLSearchParams(calls[0].body as string);
  assertEquals(form.get("grant_type"), "refresh_token");
  assertEquals(form.get("refresh_token"), "old-refresh");
  assertEquals(persisted.length, 1, "the write is awaited, not fired and forgotten");
  assertEquals(persisted[0].patch.oauth_refresh_token, "enc:new-refresh");
  assertEquals(persisted[0].patch.oauth_access_token, "enc:new-access");
  assertEquals(persisted[0].patch.oauth_token_expires_at, "2026-09-25T11:00:00.000Z");
  assertEquals(row.oauth_refresh_token, "enc:new-refresh", "the row the caller holds is fresh too");

  // The same row does not refresh again in this request.
  await withFetch([], async () => {
    assertEquals(await freshOutlookAccessToken(row, deps), "new-access");
  });
});

Deno.test("concurrent calls in one isolate share ONE refresh", async () => {
  resetOutlookTokenStateForTests();
  const { deps, persisted } = tokenDeps();
  const a = expiredRow();
  const b = expiredRow();
  const calls = await withFetch(
    () => json(200, { access_token: "shared", refresh_token: "r2", expires_in: 3600 }),
    async () => {
      const [ta, tb] = await Promise.all([freshOutlookAccessToken(a, deps), freshOutlookAccessToken(b, deps)]);
      assertEquals(ta, "shared");
      assertEquals(tb, "shared");
    },
  );
  assertEquals(calls.length, 1, "the refresh token was redeemed once");
  assertEquals(persisted.length, 1);
  assertEquals(b.oauth_refresh_token, "enc:r2", "every waiter's row gets the rotated token");
});

Deno.test("invalid_grant marks the inbox and throws outlook_auth_failed", async () => {
  resetOutlookTokenStateForTests();
  const { deps, revoked } = tokenDeps();
  await withFetch([() => json(400, { error: "invalid_grant" })], async () => {
    await assertRejects(() => freshOutlookAccessToken(expiredRow(), deps), Error, "outlook_auth_failed");
  });
  assertEquals(revoked, ["inbox-1"]);
});

Deno.test("OUTLOOK_TENANT_ID picks the authority only when it is a GUID or a domain", async () => {
  assertEquals(outlookAuthority(undefined), "common");
  assertEquals(outlookAuthority("contoso.onmicrosoft.com"), "contoso.onmicrosoft.com");
  assertEquals(outlookAuthority("6f1b1c9e-2d7a-4b8e-9c1f-0a2b3c4d5e6f"), "6f1b1c9e-2d7a-4b8e-9c1f-0a2b3c4d5e6f");
  assertEquals(outlookAuthority("organizations"), "organizations");
  assertEquals(outlookAuthority("consumers"), "consumers");
  assertEquals(outlookAuthority("../evil"), "common");
  assertEquals(outlookAuthority("https://x.y"), "common");

  resetOutlookTokenStateForTests();
  const { deps } = tokenDeps({ tenantId: "contoso.onmicrosoft.com" });
  const calls = await withFetch(
    [() => json(200, { access_token: "a", expires_in: 3600 })],
    async () => {
      await freshOutlookAccessToken(expiredRow(), deps);
    },
  );
  assertEquals(calls[0].url, "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token");
});

Deno.test("a token that is not near expiry is used without any request", async () => {
  resetOutlookTokenStateForTests();
  const { deps } = tokenDeps();
  const row = { ...expiredRow(), oauth_token_expires_at: "2026-09-25T12:00:00Z" };
  await withFetch([], async () => {
    assertEquals(await freshOutlookAccessToken(row, deps), "old-access");
  });
});

// ── Reply flow: createReply → PATCH → send ──────────────────────────────────

Deno.test("a reply is createReply, then a PATCH that keeps the quote, then /send", async () => {
  const draftHtml = '<html><head></head><body><div id="divRplyFwdMsg">From: Bob</div><div>original</div></body></html>';
  const calls = await withFetch(
    [
      () => json(201, { id: "draft-1", conversationId: "conv-1", subject: "RE: Hi", body: { contentType: "html", content: draftHtml } }),
      () => empty(200),
      () => json(201, { id: "att-1" }),
      () => empty(202),
    ],
    async () => {
      const draft = await graphPrepareResponseDraft("tok", {
        messageId: "orig/1=",
        kind: "createReplyAll",
        patch: {
          subject: "Re: Hi",
          toRecipients: [{ emailAddress: { address: "bob@example.com" } }],
          ccRecipients: [],
          bccRecipients: [{ emailAddress: { address: "audit@example.com" } }],
        },
        text: "Thanks!",
        attachments: [{ filename: "a.txt", mime_type: "text/plain", data: btoa("hello") }],
      });
      assertEquals(draft.id, "draft-1");
      assertEquals(draft.conversationId, "conv-1");
      const sent = await graphSendDraft("tok", draft.id);
      assertEquals(sent.status, 202);
    },
  );

  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages/orig%2F1%3D/createReplyAll`);
  assertStringIncludes(calls[0].headers["prefer"], IMMUTABLE_ID_PREFER);

  assertEquals(calls[1].method, "PATCH");
  assertEquals(calls[1].url, `${GRAPH_BASE}/me/messages/draft-1`);
  const patch = bodyJson(calls[1]);
  assertEquals(patch.toRecipients[0].emailAddress.address, "bob@example.com");
  assertEquals(patch.ccRecipients, [], "Graph's pre-filled Cc is overwritten, not doubled");
  assertEquals(patch.bccRecipients[0].emailAddress.address, "audit@example.com");
  assertEquals(patch.body.contentType, "HTML");
  const content: string = patch.body.content;
  assert(content.indexOf("Thanks!") < content.indexOf("divRplyFwdMsg"), "new text sits above the quote");
  assertStringIncludes(content, "<div>original</div>", "the quote is preserved");
  assert(!("internetMessageHeaders" in patch), "no custom threading headers: Graph threads createReply itself");

  assertEquals(calls[2].url, `${GRAPH_BASE}/me/messages/draft-1/attachments`);
  assertEquals(bodyJson(calls[2])["@odata.type"], "#microsoft.graph.fileAttachment");

  assertEquals(calls[3].method, "POST");
  assertEquals(calls[3].url, `${GRAPH_BASE}/me/messages/draft-1/send`);
});

Deno.test("a failed PATCH deletes the half-built reply draft and nothing is sent", async () => {
  const calls = await withFetch(
    [
      () => json(201, { id: "draft-2", body: { contentType: "html", content: "<body></body>" } }),
      () => json(400, { error: { code: "ErrorInvalidRecipients", message: "bad" } }),
      () => empty(204),
    ],
    async () => {
      await assertRejects(() =>
        graphPrepareResponseDraft("tok", { messageId: "m", kind: "createReply", patch: {}, text: "x" })
      );
    },
  );
  assertEquals(calls[2].method, "DELETE");
  assertEquals(calls[2].url, `${GRAPH_BASE}/me/messages/draft-2`);
  assert(!calls.some((c) => c.url.endsWith("/send")));
});

Deno.test("a forward without attachments drops only the non-inline files from the draft", async () => {
  const calls = await withFetch(
    [
      () => json(201, { id: "fw-1", body: { contentType: "html", content: "<body>fwd</body>" } }),
      () => empty(200),
      () =>
        json(200, {
          value: [
            { id: "a1", name: "logo.png", isInline: true, "@odata.type": "#microsoft.graph.fileAttachment" },
            { id: "a2", name: "big.pdf", isInline: false, "@odata.type": "#microsoft.graph.fileAttachment" },
          ],
        }),
      () => empty(204),
    ],
    async () => {
      await graphPrepareResponseDraft("tok", {
        messageId: "m",
        kind: "createForward",
        patch: { toRecipients: [] },
        text: "fyi",
        removeFileAttachments: true,
      });
    },
  );
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages/m/createForward`);
  assertStringIncludes(calls[2].url, "$select=id,name,contentType,size,isInline");
  assertEquals(calls[3].method, "DELETE");
  assertEquals(calls[3].url, `${GRAPH_BASE}/me/messages/fw-1/attachments/a2`);
  assertEquals(calls.length, 4);
});

Deno.test("mergeResponseBody puts HTML after <body> and prepends plain text to a text draft", () => {
  const merged = mergeResponseBody(
    { contentType: "html", content: '<html><body dir="ltr"><p>quote</p></body></html>' },
    { html: "<p>new</p>" },
  );
  assertEquals(merged.content, '<html><body dir="ltr"><p>new</p><p>quote</p></body></html>');
  const text = mergeResponseBody({ contentType: "text", content: "> quote" }, { text: "hi" });
  assertEquals(text, { contentType: "Text", content: "hi\r\n\r\n> quote" });
  const escaped = mergeResponseBody({ contentType: "html", content: "<body></body>" }, { text: "a<b" });
  assertStringIncludes(escaped.content, "a&lt;b");
});

// ── Upload sessions ─────────────────────────────────────────────────────────

Deno.test("a large attachment goes through an upload session in 320 KiB-multiple chunks, without auth", async () => {
  const size = 700 * 1024;
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  const chunk = 320 * 1024;
  const uploadUrl = "https://outlook.office.com/api/v2.0/Users('x')/Messages('d')/AttachmentSessions('s')?authtoken=abc";
  const calls = await withFetch(
    [
      () => json(201, { uploadUrl, expirationDateTime: "2026-09-25T11:00:00Z" }),
      () => json(200, { nextExpectedRanges: [`${chunk}-`] }),
      () => json(200, { nextExpectedRanges: [`${2 * chunk}-`] }),
      () => empty(201),
    ],
    async () => {
      await graphUploadLargeAttachment("tok", "draft-9", {
        filename: "big.bin",
        mime_type: "application/octet-stream",
        bytes,
      }, chunk);
    },
  );
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages/draft-9/attachments/createUploadSession`);
  const item = bodyJson(calls[0]).AttachmentItem;
  assertEquals(item.attachmentType, "file");
  assertEquals(item.size, size);
  assertEquals(item.name, "big.bin");

  const puts = calls.slice(1);
  assertEquals(puts.length, 3);
  assertEquals(puts.map((p) => p.headers["content-range"]), [
    `bytes 0-${chunk - 1}/${size}`,
    `bytes ${chunk}-${2 * chunk - 1}/${size}`,
    `bytes ${2 * chunk}-${size - 1}/${size}`,
  ]);
  for (const p of puts) {
    assertEquals(p.method, "PUT");
    assertEquals(p.url, uploadUrl);
    assertEquals(p.headers["authorization"], undefined, "the uploadUrl is pre-authenticated");
  }
  assertEquals((puts[0].body as Uint8Array).length, chunk);
  assertEquals((puts[2].body as Uint8Array)[0], bytes[2 * chunk]);
});

Deno.test("a chunk size that is not a 320 KiB multiple is refused before any request", async () => {
  await withFetch([], async () => {
    await assertRejects(
      () => graphUploadLargeAttachment("tok", "d", { filename: "f", mime_type: "x/y", bytes: new Uint8Array(10) }, 1000),
      Error,
      "320 KiB",
    );
  });
});

Deno.test("graphAddAttachments posts small files inline and uploads large ones", async () => {
  const large = new Uint8Array(3_100_000);
  const calls = await withFetch(
    (c) => {
      if (c.url.endsWith("/createUploadSession")) return json(201, { uploadUrl: "https://upload.example/s" });
      if (c.url.startsWith("https://upload.example/")) {
        const [, range] = (c.headers["content-range"] ?? "").split(" ");
        const end = Number(range.split("/")[0].split("-")[1]);
        return end === large.length - 1 ? empty(201) : json(200, {});
      }
      return json(201, { id: "att" });
    },
    async () => {
      await graphAddAttachments("tok", "d1", [
        { filename: "small.txt", mime_type: "text/plain", data: btoa("hi") },
        { filename: "large.bin", mime_type: "application/octet-stream", bytes: large },
      ]);
    },
  );
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages/d1/attachments`);
  assertEquals(bodyJson(calls[0]).contentBytes, btoa("hi"));
  assertEquals(calls[1].url, `${GRAPH_BASE}/me/messages/d1/attachments/createUploadSession`);
  assert(calls.slice(2).every((c) => c.method === "PUT"));
});

Deno.test("needsDraftUpload switches at ~3 MB of encoded payload", () => {
  assertEquals(needsDraftUpload([{ filename: "a", mime_type: "x", data: "A".repeat(1000) }]), false);
  assertEquals(needsDraftUpload([{ filename: "a", mime_type: "x", bytes: new Uint8Array(2_500_000) }]), true);
});

// ── Attachments: metadata without bytes ─────────────────────────────────────

Deno.test("attachment listing uses $select (no contentBytes) and classifies item/reference", async () => {
  let metas: Awaited<ReturnType<typeof graphListAttachmentMeta>> = [];
  const calls = await withFetch(
    [
      () =>
        json(200, {
          value: [
            { id: "f", name: "a.pdf", contentType: "application/pdf", size: 10, "@odata.type": "#microsoft.graph.fileAttachment" },
            { id: "i", name: "Fwd", size: 20, "@odata.type": "#microsoft.graph.itemAttachment" },
            { id: "r", name: "doc", size: 0, "@odata.type": "#microsoft.graph.referenceAttachment" },
          ],
        }),
    ],
    async () => {
      metas = await graphListAttachmentMeta("tok", "m1");
    },
  );
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages/m1/attachments?$select=id,name,contentType,size,isInline`);
  assertEquals(metas.map((m) => m.kind), ["file", "item", "reference"]);
  assertEquals(metas[1].contentType, "message/rfc822");
});

// ── Folders ─────────────────────────────────────────────────────────────────

Deno.test("the folder walk follows nextLink and childFolders, naming nested folders by path", async () => {
  let tree: Awaited<ReturnType<typeof listOutlookFolderTree>> = { folders: [], truncated: false };
  const next = "https://graph.microsoft.com/v1.0/me/mailFolders?$skiptoken=p2";
  const calls = await withFetch(
    (c) => {
      if (c.url === next) return json(200, { value: [{ id: "arch", displayName: "Archive", childFolderCount: 0 }] });
      if (c.url.includes("/mailFolders/inbox-id/childFolders")) {
        return json(200, { value: [{ id: "rcpt", displayName: "Receipts", childFolderCount: 1 }] });
      }
      if (c.url.includes("/mailFolders/rcpt/childFolders")) {
        return json(200, { value: [{ id: "y2026", displayName: "2026", childFolderCount: 0 }] });
      }
      return json(200, {
        value: [{ id: "inbox-id", displayName: "Inbox", childFolderCount: 1, totalItemCount: 5, unreadItemCount: 2 }],
        "@odata.nextLink": next,
      });
    },
    async () => {
      tree = await listOutlookFolderTree("tok");
    },
  );
  assertStringIncludes(calls[0].url, "/me/mailFolders?$top=100&$select=");
  assertEquals(tree.folders.map((f) => f.path), ["Inbox", "Archive", "Inbox/Receipts", "Inbox/Receipts/2026"]);
  assertEquals(tree.folders[0].unreadItemCount, 2);
  assertEquals(tree.truncated, false);

  const refs = outlookFolderReferences(tree);
  assert(refs.some((r) => r.id === "rcpt" && r.name === "Inbox/Receipts"), "by path");
  assert(refs.some((r) => r.id === "rcpt" && r.name === "Receipts"), "and by its unique leaf name");
});

Deno.test("a leaf name shared by two nested folders resolves only by path", () => {
  const refs = outlookFolderReferences({
    truncated: false,
    folders: [
      { id: "a", displayName: "A", path: "A", parentFolderId: null, depth: 0, totalItemCount: null, unreadItemCount: null },
      { id: "b", displayName: "B", path: "B", parentFolderId: null, depth: 0, totalItemCount: null, unreadItemCount: null },
      { id: "a2", displayName: "2026", path: "A/2026", parentFolderId: "a", depth: 1, totalItemCount: null, unreadItemCount: null },
      { id: "b2", displayName: "2026", path: "B/2026", parentFolderId: "b", depth: 1, totalItemCount: null, unreadItemCount: null },
    ],
  });
  assert(!refs.some((r) => r.name === "2026"), "no coin flip between two '2026' folders");
});

Deno.test("a missing archive folder is found by name, or created", async () => {
  let id = "";
  const calls = await withFetch(
    [
      () => json(404, { error: { code: "ErrorFolderNotFound", message: "not found" } }),
      () => json(200, { value: [] }),
      () => json(201, { id: "new-archive", displayName: "Archive" }),
    ],
    async () => {
      id = await resolveOutlookArchiveFolderId("tok");
    },
  );
  assertEquals(id, "new-archive");
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/mailFolders/archive?$select=id`);
  assertStringIncludes(decodeURIComponent(calls[1].url), "displayName eq 'Archive'");
  assertEquals(calls[2].method, "POST");
  assertEquals(bodyJson(calls[2]), { displayName: "Archive" });
});

Deno.test("form-encoded spaces in a query we built reach Graph as %20", async () => {
  const q = new URLSearchParams({ $filter: "isRead eq false", $search: graphSearchParam("a+b c") });
  const calls = await withFetch([() => json(200, {})], async () => {
    await graphFetch("tok", `/me/messages?${q}`);
  });
  assert(!calls[0].url.includes("+"), calls[0].url);
  assertStringIncludes(calls[0].url, "isRead%20eq%20false");
  assertStringIncludes(calls[0].url, "a%2Bb%20c", "a literal plus stays a plus");
});
