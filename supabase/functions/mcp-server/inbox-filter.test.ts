// ---------------------------------------------------------------------------
// inbox_list's filter, and the sentence it returns when nothing matches.
//
// THE REGRESSION THESE PIN. A live functional test on 2026-09-20, against a key
// with six connected mailboxes, called
//
//     inbox_list {provider: "gmail", include_capabilities: false}
//
// and was told "No mailbox is connected to this account yet". The filter matched
// nothing because the Gmail account is connected over IMAP (provider "imap",
// service "gmail"), and a filtered no-match shared the ONBOARDING branch, so
// the server asserted a falsehood and instructed the model to relay it.
//
// Two things therefore have to stay true, and each has a test below that fails
// loudly if it stops being: a no-match message must never claim the account is
// empty, and when a `provider` filter missed a same-named `service`, the
// message must say so and name the retry.
//
// Run: deno test --allow-all supabase/functions/mcp-server/inbox-filter.test.ts
// ---------------------------------------------------------------------------

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  buildFilteredNoMatchReport,
  hasInboxFilter,
  INBOX_PROVIDER_VALUES,
  INBOX_SERVICE_VALUES,
  type FilterableInbox,
  type InboxListFilter,
  matchesInboxFilter,
} from "./inbox-filter.ts";

// index.ts builds its registry at module load and reads env while doing it, so
// the environment has to be arranged BEFORE the import runs. Same dance, and
// for the same reasons, as automation-filter-fields.test.ts.
Deno.env.set("MCP_INTROSPECTION_ONLY", "1");
Deno.env.set("MCP_SERVER_NO_LISTEN", "1");
// deno-lint-ignore no-explicit-any
const { TOOL_REGISTRY } = await import("./index.ts") as any;

/** The account from the 2026-09-20 reproduction, in shape if not in full. */
const SIX: FilterableInbox[] = [
  // The one the reproduction was looking for: Gmail, app password, over IMAP.
  { email_address: "bjellanda@gmail.com", provider: "imap", service: "gmail" },
  { email_address: "asgeir@albretsen.no", provider: "imap", service: "generic" },
  { email_address: "hello@mcpemails.com", provider: "imap", service: "generic" },
  { email_address: "demo@mcpemails.com", provider: "imap", service: "generic" },
  { email_address: "noreply@mcpemails.com", provider: "imap", service: "generic" },
  { email_address: "asgeir@icloud.com", provider: "imap", service: "icloud" },
];

const NO_FILTER: InboxListFilter = { provider: null, service: null };

function filterOf(patch: Partial<InboxListFilter>): InboxListFilter {
  return { ...NO_FILTER, ...patch };
}

// ── Matching ────────────────────────────────────────────────────────────────

Deno.test("no filter matches every inbox", () => {
  assertEquals(hasInboxFilter(NO_FILTER), false);
  for (const inbox of SIX) {
    assert(matchesInboxFilter(inbox, NO_FILTER), `${inbox.email_address} is listed`);
  }
});

Deno.test("provider is the connector, not the brand", () => {
  const filter = filterOf({ provider: "gmail" });
  // The whole reproduction in one assertion: filtering on provider 'gmail'
  // does NOT find a Gmail account connected over IMAP.
  assertEquals(SIX.filter((ib) => matchesInboxFilter(ib, filter)).length, 0);
  assert(matchesInboxFilter(SIX[0], filterOf({ provider: "imap" })));
});

Deno.test("service finds the Gmail account provider could not", () => {
  const matched = SIX.filter((ib) => matchesInboxFilter(ib, filterOf({ service: "gmail" })));
  assertEquals(matched.length, 1);
  assertEquals(matched[0].email_address, "bjellanda@gmail.com");
});

Deno.test("provider and service are ANDed, not ORed", () => {
  // "the Gmail accounts I connected with an app password" is a different
  // question from either half, and has to stay answerable.
  const both = filterOf({ provider: "imap", service: "gmail" });
  assertEquals(SIX.filter((ib) => matchesInboxFilter(ib, both)).length, 1);
  const impossible = filterOf({ provider: "gmail", service: "gmail" });
  assertEquals(SIX.filter((ib) => matchesInboxFilter(ib, impossible)).length, 0);
});

Deno.test("a filter from a model is matched case-insensitively", () => {
  assert(matchesInboxFilter(SIX[0], filterOf({ service: "GMAIL" })));
  assert(matchesInboxFilter(SIX[0], filterOf({ provider: "IMAP" })));
});

Deno.test("a null service never matches a service filter", () => {
  const firstParty: FilterableInbox = {
    email_address: "x@gmail.com",
    provider: "gmail",
    service: null,
  };
  assertEquals(matchesInboxFilter(firstParty, filterOf({ service: "gmail" })), false);
  assert(matchesInboxFilter(firstParty, filterOf({ provider: "gmail" })));
});

// ── The no-match report ─────────────────────────────────────────────────────

Deno.test("a filtered no-match with inboxes present never claims the account is empty", () => {
  const report = buildFilteredNoMatchReport(filterOf({ provider: "gmail" }), SIX);

  // The exact falsehood that shipped, and the family it belongs to.
  for (const forbidden of [
    "No mailbox is connected to this account yet",
    "nothing to read or send from",
    "connect one",
    "setup_url",
  ]) {
    assert(
      !report.message.includes(forbidden),
      `a filter result must not say "${forbidden}": ${report.message}`,
    );
  }
  assertStringIncludes(report.message, "6 mailboxes are connected");
  assertStringIncludes(report.message, "filter result, not an empty account");
  // And it hands back the roster, so the caller can correct without a second call.
  assertEquals(report.available.length, 6);
  assertEquals(report.available[0].provider, "imap");
  assertEquals(report.available[0].service, "gmail");
});

Deno.test("a provider filter that missed a same-named service says so and names the retry", () => {
  const report = buildFilteredNoMatchReport(filterOf({ provider: "gmail" }), SIX);

  // This sentence is the single most useful part of the fix: it turns a dead
  // end into one more call.
  assertStringIncludes(report.message, "IS the service of one");
  assertStringIncludes(report.message, "bjellanda@gmail.com");
  assertStringIncludes(report.message, "Retry with service: 'gmail'");
  // And it explains the distinction rather than just asserting it.
  assertStringIncludes(report.message, "CONNECTOR");
  assertStringIncludes(report.message, "BRAND");
});

Deno.test("the mirror case: a service filter that missed a same-named provider", () => {
  const withFastmail: FilterableInbox[] = [
    { email_address: "a@fastmail.com", provider: "fastmail", service: null },
    ...SIX,
  ];
  const report = buildFilteredNoMatchReport(filterOf({ service: "fastmail" }), withFastmail);
  assertStringIncludes(report.message, "IS the provider of one");
  assertStringIncludes(report.message, "a@fastmail.com");
  assertStringIncludes(report.message, "Retry with provider: 'fastmail'");
});

Deno.test("a no-match with no same-named counterpart still reports the roster", () => {
  const report = buildFilteredNoMatchReport(filterOf({ service: "yandex" }), SIX);
  assertStringIncludes(report.message, "No connected inbox matches service 'yandex'");
  assertStringIncludes(report.message, "6 mailboxes are connected");
  assertStringIncludes(report.message, "asgeir@icloud.com (provider imap, service icloud)");
  // No counterpart exists, so no misleading "but it IS the ..." clause.
  assert(!report.message.includes("but it IS"), report.message);
});

Deno.test("both filters named are both quoted back", () => {
  const report = buildFilteredNoMatchReport(
    filterOf({ provider: "outlook", service: "zoho" }),
    SIX,
  );
  assertStringIncludes(report.message, "provider 'outlook' and service 'zoho'");
});

Deno.test("one connected inbox is described in the singular", () => {
  const report = buildFilteredNoMatchReport(filterOf({ provider: "outlook" }), [SIX[0]]);
  assertStringIncludes(report.message, "1 mailbox is connected");
});

Deno.test("a large account does not flood the message", () => {
  const many: FilterableInbox[] = Array.from({ length: 40 }, (_, i) => ({
    email_address: `user${i}@example.com`,
    provider: "imap",
    service: "generic",
  }));
  const report = buildFilteredNoMatchReport(filterOf({ provider: "outlook" }), many);
  assertStringIncludes(report.message, "and 28 more");
  // The payload is never truncated, only the prose.
  assertEquals(report.available.length, 40);
});

// ── The published schema ────────────────────────────────────────────────────

Deno.test("inbox_list advertises both filter axes with the values the DB permits", () => {
  // deno-lint-ignore no-explicit-any
  const tool = (TOOL_REGISTRY as any[]).find((t) => t.name === "inbox_list");
  assert(tool, "inbox_list is registered");
  const props = tool.inputSchema.properties;

  assertEquals(props.provider.enum, [...INBOX_PROVIDER_VALUES]);
  assert(props.service, "a service filter is advertised at all — 'show me my Gmail' has to be expressible");
  assertEquals(props.service.enum, [...INBOX_SERVICE_VALUES]);

  // Each description has to draw the distinction, because a caller reading only
  // the provider enum is exactly the caller that files this bug again.
  assertStringIncludes(props.provider.description, "CONNECTOR");
  assertStringIncludes(props.service.description, "BRAND");
});

Deno.test("inbox_list's output schema declares every key its empty payloads carry", () => {
  // deno-lint-ignore no-explicit-any
  const tool = (TOOL_REGISTRY as any[]).find((t) => t.name === "inbox_list");
  const out = tool.outputSchema;
  // additionalProperties: false, so an undeclared key is a payload a strict
  // client rejects. setup_required and friends shipped undeclared for months.
  assertEquals(out.additionalProperties, false);
  for (const key of ["inboxes", "setup_required", "setup_url", "matched", "filter", "available", "message"]) {
    assert(key in out.properties, `outputSchema declares ${key}`);
  }
});
