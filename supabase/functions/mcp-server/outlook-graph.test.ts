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
  classifyGraphMailboxResponse,
  DEFAULT_GRAPH_RETRY,
  freshOutlookAccessToken,
  GRAPH_BASE,
  GRAPH_EPOCH_FILTER,
  graphAddAttachments,
  graphErrorFromResponse,
  graphFetch,
  graphFilterForDateOrder,
  graphCopyMessage,
  graphEnsureParentFolders,
  graphFolderLabels,
  graphImmutableMessageIds,
  graphListAttachmentMeta,
  graphSendFailure,
  GraphSendRefusedError,
  outlookListTotal,
  OUTLOOK_ARCHIVE_FOLDER_NAMES,
  splitOutlookFolderPath,
  graphPrepareResponseDraft,
  graphSearchParam,
  graphSendDraft,
  graphUploadLargeAttachment,
  IMMUTABLE_ID_PREFER,
  isGraphMailboxRoot,
  listOutlookFolderTree,
  mergeResponseBody,
  needsDraftUpload,
  OutlookGraphError,
  OUTLOOK_NO_MAILBOX_MESSAGE,
  outlookAccessTokenForGraph,
  outlookAuthority,
  OutlookNoMailboxError,
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

// ── 401 recovery and "no mailbox" (live finding 2026-09-25) ─────────────────
//
// An Entra account with no Exchange Online mailbox gets a valid token and a
// Graph 401 with an EMPTY body on every mailbox call, even after a refresh.
// Reading that 401 as "reconnect" looped the user forever.

function noMailboxDeps() {
  const base = tokenDeps();
  const noMailbox: string[] = [];
  base.deps.markNoMailbox = (id) => {
    noMailbox.push(id);
    return Promise.resolve();
  };
  return { ...base, noMailbox };
}

const liveRow = (): OutlookTokenRow => ({ ...expiredRow(), oauth_token_expires_at: "2026-09-25T12:00:00Z" });
const refreshOk = () => json(200, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });

Deno.test("a 401 on a stored token forces ONE refresh and retries; success carries on", async () => {
  resetOutlookTokenStateForTests();
  const { deps, persisted, noMailbox, revoked } = noMailboxDeps();
  const row = liveRow();
  let status = 0;
  const calls = await withFetch([() => empty(401), refreshOk, () => json(200, { id: "inbox" })], async () => {
    const token = await outlookAccessTokenForGraph(row, deps);
    assertEquals(token, "old-access");
    status = (await graphFetch(token, "/me/mailFolders/inbox?$select=id")).status;
  });
  assertEquals(status, 200);
  assertEquals(calls.length, 3);
  assertEquals(calls[0].headers["authorization"], "Bearer old-access");
  assert(calls[1].url.startsWith("https://login.microsoftonline.com/"), "the second request is the refresh");
  assertEquals(calls[2].headers["authorization"], "Bearer new-access");
  assertEquals(persisted.length, 1, "the rotated tokens are stored");
  assertEquals(noMailbox, []);
  assertEquals(revoked, []);

  // The caller still holds "old-access"; the next call goes out with the new one.
  const later = await withFetch([() => json(200, {})], async () => {
    await graphFetch("old-access", "/me/messages?$top=1");
  });
  assertEquals(later[0].headers["authorization"], "Bearer new-access");
});

Deno.test("a 401 that survives a fresh token is 'no mailbox', never reconnect", async () => {
  resetOutlookTokenStateForTests();
  const { deps, noMailbox, revoked } = noMailboxDeps();
  const calls = await withFetch([() => empty(401), refreshOk, () => empty(401)], async () => {
    const token = await outlookAccessTokenForGraph(liveRow(), deps);
    const err = await assertRejects(() => graphFetch(token, "/me/messages?$top=5"), OutlookNoMailboxError);
    assertEquals(err.message, OUTLOOK_NO_MAILBOX_MESSAGE);
  });
  assertEquals(calls.length, 3, "exactly one refresh, exactly one retry");
  assertEquals(noMailbox, ["inbox-1"]);
  assertEquals(revoked, [], "the inbox is not marked revoked");
  assert(!/reconnect it|please reconnect/i.test(OUTLOOK_NO_MAILBOX_MESSAGE));
  assertStringIncludes(OUTLOOK_NO_MAILBOX_MESSAGE, "IMAP");
});

Deno.test("a 401 on a token refreshed moments ago is 'no mailbox' without a second refresh", async () => {
  resetOutlookTokenStateForTests();
  const { deps, noMailbox } = noMailboxDeps();
  const calls = await withFetch([refreshOk, () => empty(401)], async () => {
    const token = await outlookAccessTokenForGraph(expiredRow(), deps);
    assertEquals(token, "new-access");
    await assertRejects(() => graphFetch(token, "/me/mailFolders/inbox?$select=id"), OutlookNoMailboxError);
  });
  assertEquals(calls.length, 2);
  assertEquals(noMailbox, ["inbox-1"]);
});

Deno.test("invalid_grant on the forced refresh is still the reconnect case", async () => {
  resetOutlookTokenStateForTests();
  const { deps, noMailbox, revoked } = noMailboxDeps();
  await withFetch([() => empty(401), () => json(400, { error: "invalid_grant" })], async () => {
    const token = await outlookAccessTokenForGraph(liveRow(), deps);
    await assertRejects(() => graphFetch(token, "/me/messages"), Error, "outlook_auth_failed");
  });
  assertEquals(revoked, ["inbox-1"]);
  assertEquals(noMailbox, []);
});

Deno.test("MailboxNotEnabledForRESTAPI is 'no mailbox' at once, with no refresh", async () => {
  resetOutlookTokenStateForTests();
  const { deps, noMailbox } = noMailboxDeps();
  const calls = await withFetch(
    [() => json(401, { error: { code: "MailboxNotEnabledForRESTAPI", message: "REST API is not yet supported for this mailbox." } })],
    async () => {
      const token = await outlookAccessTokenForGraph(liveRow(), deps);
      await assertRejects(() => graphFetch(token, "/me/messages"), OutlookNoMailboxError);
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(noMailbox, ["inbox-1"]);
});

Deno.test("a 404 on a mailbox root is 'no mailbox'; a 404 on one message is not", async () => {
  resetOutlookTokenStateForTests();
  const { deps, noMailbox } = noMailboxDeps();
  await withFetch([() => json(404, { error: { code: "ErrorItemNotFound" } })], async () => {
    const token = await outlookAccessTokenForGraph(liveRow(), deps);
    const resp = await graphFetch(token, "/me/messages/AAMkAD123");
    assertEquals(resp.status, 404, "the caller still maps its own message_not_found");
    await resp.body?.cancel();
  });
  assertEquals(noMailbox, []);
  await withFetch([() => empty(404)], async () => {
    const token = await outlookAccessTokenForGraph(liveRow(), deps);
    await assertRejects(() => graphFetch(token, "/me/mailFolders/inbox?$select=id"), OutlookNoMailboxError);
  });
  assertEquals(noMailbox, ["inbox-1"]);
});

Deno.test("a 401 on a token nobody registered is returned untouched (bare graphFetch)", async () => {
  resetOutlookTokenStateForTests();
  await withFetch([() => empty(401)], async () => {
    const resp = await graphFetch("unregistered", "/me/messages");
    assertEquals(resp.status, 401);
    const err = await graphErrorFromResponse(resp, "list");
    assertEquals(err.message, "outlook_auth_failed");
  });
});

Deno.test("the mailbox-root and verdict helpers", () => {
  assert(isGraphMailboxRoot(`${GRAPH_BASE}/me/messages?$top=1`));
  assert(isGraphMailboxRoot(`${GRAPH_BASE}/me/mailFolders/inbox?$select=id`));
  assert(isGraphMailboxRoot(`${GRAPH_BASE}/me/mailFolders`));
  assert(!isGraphMailboxRoot(`${GRAPH_BASE}/me/messages/abc`));
  assert(!isGraphMailboxRoot(`${GRAPH_BASE}/me/mailFolders/abc/messages`));
  assertEquals(classifyGraphMailboxResponse(401, null, `${GRAPH_BASE}/me/messages/x`), "unauthorized");
  assertEquals(classifyGraphMailboxResponse(403, "ErrorMailboxNotFound", `${GRAPH_BASE}/me/messages/x`), "no_mailbox");
  assertEquals(classifyGraphMailboxResponse(403, "ErrorAccessDenied", `${GRAPH_BASE}/me/messages`), "other");
  assertEquals(classifyGraphMailboxResponse(404, "ErrorFolderNotFound", `${GRAPH_BASE}/me/mailFolders/x`), "other");
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

Deno.test("the archive role tries the well-known name first and stops there when it exists", async () => {
  let id = "";
  const calls = await withFetch([() => json(200, { id: "wk-archive" })], async () => {
    id = await resolveOutlookArchiveFolderId("tok");
  });
  assertEquals(id, "wk-archive");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/mailFolders/archive?$select=id`);
});

Deno.test("a mailbox whose archive is 'Arkiver' gets Arkiver, never a second English 'Archive'", async () => {
  let id = "";
  const calls = await withFetch(
    [
      () => json(404, { error: { code: "ErrorFolderNotFound", message: "not found" } }),
      () =>
        json(200, {
          value: [
            { id: "f-inbox", displayName: "Innboks" },
            { id: "f-sent", displayName: "Sendte elementer" },
            { id: "f-arkiver", displayName: "Arkiver" },
          ],
        }),
    ],
    async () => {
      id = await resolveOutlookArchiveFolderId("tok");
    },
  );
  assertEquals(id, "f-arkiver");
  assertEquals(calls.length, 2, "no create");
  assertEquals(calls[1].method, "GET");
  assertStringIncludes(calls[1].url, "/me/mailFolders?");
  assert(OUTLOOK_ARCHIVE_FOLDER_NAMES.includes("Arkiver"));
});

Deno.test("localised archive names match case-insensitively, across pages, in preference order", async () => {
  let id = "";
  await withFetch(
    [
      () => json(404, { error: { code: "ErrorFolderNotFound", message: "not found" } }),
      () =>
        json(200, {
          value: [{ id: "f-arkiv", displayName: "arkiv" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders?$skip=100",
        }),
      () => json(200, { value: [{ id: "f-archive", displayName: "ARCHIVE" }] }),
    ],
    async () => {
      id = await resolveOutlookArchiveFolderId("tok");
    },
  );
  assertEquals(id, "f-archive", "'Archive' outranks 'Arkiv' when both exist");
});

Deno.test("with no archive folder under any known name, one is created as the last resort", async () => {
  let id = "";
  const calls = await withFetch(
    [
      () => json(404, { error: { code: "ErrorFolderNotFound", message: "not found" } }),
      () => json(200, { value: [{ id: "f-inbox", displayName: "Inbox" }] }),
      () => json(201, { id: "new-archive", displayName: "Archive" }),
    ],
    async () => {
      id = await resolveOutlookArchiveFolderId("tok");
    },
  );
  assertEquals(id, "new-archive");
  assertEquals(calls[2].method, "POST");
  assertEquals(calls[2].url, `${GRAPH_BASE}/me/mailFolders`);
  assertEquals(bodyJson(calls[2]), { displayName: "Archive" });
});

// ── send refusals ────────────────────────────────────────────────────────────

Deno.test("a 403 ErrorAccountSuspend on /send is a definite, account-level refusal with a remedy", async () => {
  const box: { err?: Error } = {};
  await withFetch(
    [() => json(403, { error: { code: "ErrorAccountSuspend", message: "Account suspended." } })],
    async () => {
      const resp = await graphSendDraft("tok", "draft-1");
      box.err = await graphSendFailure(resp, "Outlook send draft");
    },
  );
  const err = box.err;
  assert(err instanceof GraphSendRefusedError);
  const refused = err as GraphSendRefusedError;
  assertEquals(refused.status, 403);
  assertEquals(refused.code, "ErrorAccountSuspend");
  assertEquals(refused.graphMessage, "Account suspended.");
  assertEquals(refused.accountLevel, true);
  assertStringIncludes(refused.hint ?? "", "sign in at outlook.com");
});

Deno.test("a 400 about the message is a refusal too, but not account-level", async () => {
  const err = await graphSendFailure(
    json(400, { error: { code: "ErrorInvalidRecipients", message: "At least one recipient is not valid." } }),
    "Outlook send",
  );
  assert(err instanceof GraphSendRefusedError);
  assertEquals((err as GraphSendRefusedError).accountLevel, false);
});

Deno.test("send failures: 401 is auth, 429 (after retries) is quota, 5xx stays an unknown-outcome error", async () => {
  assertEquals((await graphSendFailure(empty(401), "x")).message, "outlook_auth_failed");
  assertEquals((await graphSendFailure(empty(429), "x")).message, "quota_exceeded");
  const five = await graphSendFailure(json(504, { error: { code: "GatewayTimeout", message: "t" } }), "x");
  assert(!(five instanceof GraphSendRefusedError), "a 5xx may have been processed");
  assert(five instanceof OutlookGraphError);
});

// ── $search ids ──────────────────────────────────────────────────────────────

Deno.test("search ids are re-read in $batch GETs of 20 that carry the ImmutableId Prefer", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `AQMkAD-${i}`);
  let out = new Map<string, string>();
  const calls = await withFetch(
    (call) => {
      const reqs = (bodyJson(call) as { requests: { id: string; url: string }[] }).requests;
      return json(200, {
        responses: reqs.map((r) => ({
          id: r.id,
          status: 200,
          body: { id: `IMM-${decodeURIComponent(r.url.split("/")[3].split("?")[0])}` },
        })),
      });
    },
    async () => {
      out = await graphImmutableMessageIds("tok", ids);
    },
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url, `${GRAPH_BASE}/$batch`);
  assertEquals(calls[0].method, "POST");
  const first = bodyJson(calls[0]) as { requests: { method: string; url: string; headers: Record<string, string> }[] };
  assertEquals(first.requests.length, 20);
  assertEquals(first.requests[0].method, "GET");
  assertEquals(first.requests[0].url, "/me/messages/AQMkAD-0?$select=id");
  assertEquals(first.requests[0].headers.Prefer, IMMUTABLE_ID_PREFER);
  assertEquals((bodyJson(calls[1]) as { requests: unknown[] }).requests.length, 5);
  assertEquals(out.get("AQMkAD-0"), "IMM-AQMkAD-0");
  assertEquals(out.get("AQMkAD-24"), "IMM-AQMkAD-24");
});

Deno.test("a throttled batch leg is retried alone; a vanished message keeps its search id", async () => {
  let out = new Map<string, string>();
  const calls = await withFetch(
    [
      () =>
        json(200, {
          responses: [
            { id: "1", status: 429, body: {} },
            { id: "0", status: 200, body: { id: "IMM-a" } },
            { id: "2", status: 404, body: { error: { code: "ErrorItemNotFound" } } },
          ],
        }),
      () => json(200, { id: "IMM-b" }),
    ],
    async () => {
      out = await graphImmutableMessageIds("tok", ["a", "b", "c"]);
    },
  );
  assertEquals(out.get("a"), "IMM-a");
  assertEquals(out.get("b"), "IMM-b");
  assertEquals(out.get("c"), "c");
  assertEquals(calls[1].url, `${GRAPH_BASE}/me/messages/b?$select=id`);
  assertStringIncludes(calls[1].headers["prefer"], IMMUTABLE_ID_PREFER);
});

// ── folder labels ────────────────────────────────────────────────────────────

Deno.test("search rows are labelled with their real folder: INBOX for the inbox, a path otherwise", async () => {
  const folders: Record<string, { displayName: string; parentFolderId: string }> = {
    "f-arkiver": { displayName: "Arkiver", parentFolderId: "root" },
    "f-2024": { displayName: "2024", parentFolderId: "f-arkiver" },
  };
  let labels = new Map<string, string>();
  await withFetch(
    (call) => {
      const path = call.url.replace(GRAPH_BASE, "").split("?")[0];
      if (path === "/me/mailFolders/inbox") return json(200, { id: "f-inbox" });
      if (path === "/me/mailFolders/msgfolderroot") return json(200, { id: "root" });
      const id = decodeURIComponent(path.split("/")[3]);
      const f = folders[id];
      return f ? json(200, { id, ...f }) : json(404, { error: { code: "ErrorItemNotFound", message: "x" } });
    },
    async () => {
      labels = await graphFolderLabels("tok", ["f-inbox", "f-arkiver", "f-2024", "f-gone", "f-arkiver"]);
    },
  );
  assertEquals(labels.get("f-inbox"), "INBOX");
  assertEquals(labels.get("f-arkiver"), "Arkiver");
  assertEquals(labels.get("f-2024"), "Arkiver/2024");
  assertEquals(labels.get("f-gone"), "f-gone", "an unreadable folder keeps its id, never a made-up name");
});

// ── nested folder create ─────────────────────────────────────────────────────

Deno.test("splitOutlookFolderPath reads Parent/Child as a path", () => {
  assertEquals(splitOutlookFolderPath("Parent/Child"), ["Parent", "Child"]);
  assertEquals(splitOutlookFolderPath(" /A//B/ "), ["A", "B"]);
  assertEquals(splitOutlookFolderPath("Plain"), ["Plain"]);
});

Deno.test("a nested create resolves an existing parent by name and returns its id", async () => {
  let parent: string | null = null;
  const calls = await withFetch(
    [() => json(200, { value: [{ id: "f-parent", displayName: "Parent" }] })],
    async () => {
      parent = await graphEnsureParentFolders("tok", ["Parent", "Child"]);
    },
  );
  assertEquals(parent, "f-parent");
  assertEquals(calls.length, 1);
  assertStringIncludes(decodeURIComponent(calls[0].url), "/me/mailFolders?$filter=displayName eq 'Parent'");
});

Deno.test("a missing parent is created (as IMAP CREATE does), then the next level under it", async () => {
  let parent: string | null = null;
  const calls = await withFetch(
    [
      () => json(200, { value: [] }), // A? no
      () => json(201, { id: "f-a", displayName: "A" }), // create A
      () => json(200, { value: [] }), // A/B? no
      () => json(201, { id: "f-b", displayName: "B" }), // create A/B
    ],
    async () => {
      parent = await graphEnsureParentFolders("tok", ["A", "B", "Leaf"]);
    },
  );
  assertEquals(parent, "f-b");
  assertEquals(calls[1].url, `${GRAPH_BASE}/me/mailFolders`);
  assertEquals(bodyJson(calls[1]), { displayName: "A" });
  assertStringIncludes(decodeURIComponent(calls[2].url), "/me/mailFolders/f-a/childFolders?$filter=displayName eq 'B'");
  assertEquals(calls[3].url, `${GRAPH_BASE}/me/mailFolders/f-a/childFolders`);
  assertEquals(bodyJson(calls[3]), { displayName: "B" });
});

Deno.test("a first segment naming a role uses the well-known folder when no folder has that name", async () => {
  let parent: string | null = null;
  const calls = await withFetch([() => json(200, { value: [] })], async () => {
    parent = await graphEnsureParentFolders("tok", ["Inbox", "Receipts"], (s) => s.toLowerCase() === "inbox" ? "inbox" : null);
  });
  assertEquals(parent, "inbox");
  assertEquals(calls.length, 1, "no folder is created for a role");
});

Deno.test("an OData literal doubles single quotes", async () => {
  const calls = await withFetch([() => json(200, { value: [] }), () => json(201, { id: "x" })], async () => {
    await graphEnsureParentFolders("tok", ["O'Brien", "Leaf"]);
  });
  assertStringIncludes(decodeURIComponent(calls[0].url), "displayName eq 'O''Brien'");
});

// ── copy ─────────────────────────────────────────────────────────────────────

Deno.test("copy returns the NEW message's id from Graph's 201", async () => {
  let id: string | null = null;
  const calls = await withFetch([() => json(201, { id: "copy-imm-1", subject: "s" })], async () => {
    id = await graphCopyMessage("tok", "orig-1", "f-dest");
  });
  assertEquals(id, "copy-imm-1");
  assertEquals(calls[0].url, `${GRAPH_BASE}/me/messages/orig-1/copy`);
  assertEquals(bodyJson(calls[0]), { destinationId: "f-dest" });
  await withFetch([() => json(404, { error: { code: "ErrorItemNotFound", message: "x" } })], async () => {
    await assertRejects(() => graphCopyMessage("tok", "gone", "f"), Error, "message_not_found");
  });
});

// ── list totals ──────────────────────────────────────────────────────────────

Deno.test("list totals: the last page is exact, otherwise the folder counters, never below what was shown", () => {
  // The live case: five unread, a stale count of six. Last page, so 5.
  assertEquals(outlookListTotal({ counts: { total: 40, unread: 6 }, unread: true, offset: 0, returned: 5, hasMore: false }), 5);
  // More pages: the unread counter.
  assertEquals(outlookListTotal({ counts: { total: 40, unread: 12 }, unread: true, offset: 0, returned: 10, hasMore: true }), 12);
  // Read-only list: total minus unread.
  assertEquals(outlookListTotal({ counts: { total: 40, unread: 12 }, unread: false, offset: 0, returned: 10, hasMore: true }), 28);
  // A counter that lags behind the page is clamped up.
  assertEquals(outlookListTotal({ counts: { total: 3, unread: 0 }, unread: undefined, offset: 0, returned: 10, hasMore: true }), 11);
  // No counters, not the last page: unknown.
  assertEquals(outlookListTotal({ counts: null, unread: undefined, offset: 0, returned: 10, hasMore: true }), null);
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

// ── index.ts wiring (source scan: index.ts runs Deno.serve at import) ────────

Deno.test("index.ts hands Graph call sites tokens WITH 401 recovery, and says 'no mailbox' not 'reconnect'", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const fn = src.slice(src.indexOf("async function withFreshOutlookToken("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assertStringIncludes(body, "outlookAccessTokenForGraph(inbox,");
  assertStringIncludes(body, "markNoMailbox:");
  assertStringIncludes(body, "last_error: OUTLOOK_NO_MAILBOX_MESSAGE");
  assertStringIncludes(body, "store.outlookNoMailbox = true");
  assert(!/freshOutlookAccessToken\(/.test(src), "no Graph token may bypass the recovery");
  assertStringIncludes(src, "if (logCtx.outlookNoMailbox) rewriteNoMailboxResult(toolResult);");
});

/** The body of `async function <name>(` in index.ts, up to its closing brace at column 0. */
function indexFunction(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`index.ts has no async function ${name}`);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
}

Deno.test("index.ts: an Outlook sender forwards through createForward, never the MIME relay", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const relay = indexFunction(src, "forwardRelayMessage");
  const outlookBranch = relay.indexOf('if (inbox.provider === "outlook") return await outlookForward(');
  assert(outlookBranch !== -1, "the Outlook branch exists");
  assert(outlookBranch < relay.indexOf("readOriginalMessage("), "and runs before the raw original is read");
  assert(!relay.includes("GRAPH_MIME_SEND_MAX_BYTES"), "no size-based fallback back into the relay");

  const viaDraft = indexFunction(src, "outlookForwardViaDraft");
  assertStringIncludes(viaDraft, 'kind: "createForward"');
  assertStringIncludes(viaDraft, "removeFileAttachments: !params.includeAttachments");
  assertStringIncludes(viaDraft, 'mime_type: "message/rfc822"');
  assert(!/const addressing = \{[^}]*subject/.test(viaDraft), "inline keeps Graph's own (localised) subject");
  assertStringIncludes(viaDraft, "graphSendFailure(sendResp");

  const raw = indexFunction(src, "transmitRawMessage");
  assertStringIncludes(raw, 'throw new Error("outlook_raw_send_unsupported")');
  assert(!raw.includes("/me/sendMail"), "Graph MIME sendMail is gone from the raw path");
});

Deno.test("index.ts: a Graph send refusal is reported as not sent everywhere a send can fail", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const op of ["email_forward", "email_reply", "email_send", "draft_send"]) {
    assert(
      new RegExp(`err instanceof GraphSendRefusedError\\) \\{\\s*return graphRefusedResult\\("${op}"`).test(src),
      `${op} maps GraphSendRefusedError to graphRefusedResult`,
    );
  }
  const classify = src.slice(src.indexOf("function classifyForwardFailure("));
  const refusedArm = classify.slice(classify.indexOf("err instanceof GraphSendRefusedError"));
  assertStringIncludes(refusedArm.slice(0, 600), 'status: "not_sent"');
  assertStringIncludes(refusedArm.slice(0, 600), "fatal: err.accountLevel");
  for (const fn of ["sendOutlookMessage", "outlookSendDraft", "outlookForwardViaDraft"]) {
    assertStringIncludes(indexFunction(src, fn), "graphSendFailure(");
  }
  const refused = src.slice(src.indexOf("function graphRefusedResult("));
  assertStringIncludes(refused.slice(0, 900), "delivery_status: DELIVERY_STATUS_NOT_SENT");
});

Deno.test("index.ts: Outlook search returns immutable ids and real folder labels", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const search = indexFunction(src, "searchOutlookMessages");
  assertStringIncludes(search, "graphImmutableMessageIds(accessToken");
  assertStringIncludes(search, "graphFolderLabels(");
  assertStringIncludes(search, "id: immutableIds.get(msg.id) ?? msg.id");
  assert(!search.includes('folder: "INBOX", url: "/me/messages"'), "the whole-mailbox leg is not labelled INBOX");
});

Deno.test("index.ts: the Outlook list counts from the folder and learns has_more from one extra row", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const list = indexFunction(src, "listOutlookMessages");
  assertStringIncludes(list, "$top: String(limit + 1)");
  assertStringIncludes(list, "outlookFolderCounts(accessToken, folderSegment)");
  assert(!list.includes('$count: "true"'), "no eventually-consistent $count");
  assert(!list.includes(`data["@odata.nextLink"]`), "has_more is not read from nextLink");
});

Deno.test("index.ts: Outlook permanent delete, flagged search, nested create and copy id are wired", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const caps = src.slice(src.indexOf("  outlook: {\n    flags: true,"));
  assertStringIncludes(caps.slice(0, 700), 'trash_vs_expunge: "both"');
  const profile = src.slice(src.indexOf('profile: "outlook-v1"'));
  assertStringIncludes(profile.slice(0, 700), '"delete.permanent": "exact"');
  assertStringIncludes(profile.slice(0, 700), '"search.flagged": "exact"');
  assert(!src.includes("Ignored on Outlook."), "the flagged schema text no longer says Outlook ignores it");

  const create = indexFunction(src, "outlookCreateFolder");
  assertStringIncludes(create, "graphEnsureParentFolders(");
  assertStringIncludes(create, "/childFolders");

  assertStringIncludes(indexFunction(src, "executeCopyEmail"), "new_message_id: newMessageId");
});
