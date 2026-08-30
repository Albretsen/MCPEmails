// ---------------------------------------------------------------------------
// Pagination envelope tests.
//
// What is asserted here is not arithmetic, it is non-contradiction: whatever a
// provider hands us, the four fields we emit must agree with the page sitting
// next to them. Each production repro from 2026-08-30 has a test named after
// it, so a regression fails with the original symptom rather than a diff.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildContactSearchEnvelope,
  buildPaginationEnvelope,
} from "./pagination-envelope.ts";

Deno.test("last page: has_more false and next_offset null", () => {
  const env = buildPaginationEnvelope({
    returned: 4,
    offset: 10,
    limit: 25,
    total: 14,
    totalIsEstimate: false,
    hasMore: false,
  });
  assertEquals(env.has_more, false);
  assertEquals(env.next_offset, null);
  assertEquals(env.total, 14);
  assertEquals(env.total_is_estimate, false);
});

Deno.test("production repro: has_more false never carries an offset", () => {
  // Observed live: {"has_more":false,"next_offset":50}
  const env = buildPaginationEnvelope({
    returned: 3,
    offset: 25,
    limit: 25,
    total: 28,
    totalIsEstimate: false,
    hasMore: false,
  });
  assertEquals(env.next_offset, null);
});

Deno.test("full page with more behind it: strictly increasing next_offset", () => {
  const env = buildPaginationEnvelope({
    returned: 25,
    offset: 0,
    limit: 25,
    total: 201,
    totalIsEstimate: true,
    hasMore: true,
  });
  assertEquals(env.has_more, true);
  assertEquals(env.next_offset, 25);
  assert(env.next_offset! > 0, "next_offset must advance past the current offset");

  const second = buildPaginationEnvelope({
    returned: 25,
    offset: 25,
    limit: 25,
    total: 201,
    totalIsEstimate: true,
    hasMore: true,
  });
  assertEquals(second.next_offset, 50);
  assert(second.next_offset! > env.next_offset!, "offsets must strictly increase");
});

Deno.test("production repro: 3 results never yield total 0 flagged exact", () => {
  // Observed live on a label listing: {"total":0,"total_is_estimate":false}
  // alongside three returned messages.
  const env = buildPaginationEnvelope({
    returned: 3,
    offset: 0,
    limit: 25,
    total: 0,
    totalIsEstimate: false,
    hasMore: false,
  });
  assertEquals(env.total, 3);
  assert(env.total_is_estimate, "a total that had to be corrected is not exact");
  assertEquals(env.has_more, false);
  assertEquals(env.next_offset, null);
});

Deno.test("total is never below the results already seen", () => {
  const env = buildPaginationEnvelope({
    returned: 10,
    offset: 40,
    limit: 10,
    total: 12,
    totalIsEstimate: false,
    hasMore: false,
  });
  assertEquals(env.total, 50);
  assertEquals(env.total_is_estimate, true);
});

Deno.test("has_more true forces total strictly above what was seen", () => {
  const env = buildPaginationEnvelope({
    returned: 10,
    offset: 0,
    limit: 10,
    total: 10,
    totalIsEstimate: false,
    hasMore: true,
  });
  assertEquals(env.total, 11);
  assertEquals(env.total_is_estimate, true);
});

Deno.test("an overestimate is left alone but stays flagged", () => {
  // Gmail's resultSizeEstimate cannot be disproved from here; it must not be
  // silently "corrected" into a number claiming to be exact.
  const env = buildPaginationEnvelope({
    returned: 5,
    offset: 0,
    limit: 5,
    total: 201,
    totalIsEstimate: true,
    hasMore: true,
  });
  assertEquals(env.total, 201);
  assertEquals(env.total_is_estimate, true);
});

Deno.test("zero results yield a coherent envelope", () => {
  const env = buildPaginationEnvelope({
    returned: 0,
    offset: 0,
    limit: 20,
    total: 0,
    totalIsEstimate: false,
    hasMore: false,
  });
  assertEquals(env.total, 0);
  assertEquals(env.total_is_estimate, false);
  assertEquals(env.has_more, false);
  assertEquals(env.next_offset, null);
});

Deno.test("zero results past the end of a known set keeps the known total", () => {
  const env = buildPaginationEnvelope({
    returned: 0,
    offset: 100,
    limit: 20,
    total: 14,
    totalIsEstimate: false,
    hasMore: false,
  });
  // An empty page proves nothing about the size of the set, so an exact 14 must
  // survive being asked for offset 100 rather than inflating to 100.
  assertEquals(env.total, 14);
  assertEquals(env.total_is_estimate, false);
  assertEquals(env.next_offset, null);
});

Deno.test("an unknown total stays null and is not called an estimate", () => {
  const env = buildPaginationEnvelope({
    returned: 12,
    offset: 0,
    limit: 25,
    total: null,
    hasMore: false,
  });
  assertEquals(env.total, null);
  assertEquals(env.total_is_estimate, false);
  assertEquals(env.next_offset, null);
});

Deno.test("an unknown total with more pages still yields a usable offset", () => {
  const env = buildPaginationEnvelope({
    returned: 25,
    offset: 0,
    limit: 25,
    total: undefined,
    hasMore: true,
  });
  assertEquals(env.total, null);
  assertEquals(env.has_more, true);
  assertEquals(env.next_offset, 25);
});

Deno.test("nonsense inputs degrade to a coherent envelope", () => {
  const env = buildPaginationEnvelope({
    returned: -3,
    offset: -10,
    limit: 0,
    total: Number.NaN,
    hasMore: false,
  });
  assertEquals(env.total, null);
  assertEquals(env.has_more, false);
  assertEquals(env.next_offset, null);
});

// ---------------------------------------------------------------------------
// contact_search
// ---------------------------------------------------------------------------

const CONTACTS = Array.from({ length: 7 }, (_, i) => ({
  inbox_id: "inbox-1",
  email_address: `person${i}@example.com`,
  display_name: `Person ${i}`,
}));

Deno.test("contact_search envelope always carries the untrusted marker", () => {
  const env = buildContactSearchEnvelope({
    query: "a",
    allContacts: CONTACTS,
    offset: 0,
    limit: 20,
    scanTruncated: false,
  });
  assertEquals(env.untrusted_content, true);

  // Including the empty case: a caller must never see a contact_search result
  // without the marker, whatever the scan found.
  const empty = buildContactSearchEnvelope({
    query: "nobody",
    allContacts: [],
    offset: 0,
    limit: 20,
    scanTruncated: false,
  });
  assertEquals(empty.untrusted_content, true);
  assertEquals(empty.contacts, []);
  assertEquals(empty.total, 0);
  assertEquals(empty.has_more, false);
  assertEquals(empty.next_offset, null);
});

Deno.test("contact_search paginates instead of echoing the page size", () => {
  const first = buildContactSearchEnvelope({
    query: "a",
    allContacts: CONTACTS,
    offset: 0,
    limit: 3,
    scanTruncated: false,
  });
  assertEquals(first.contacts.length, 3);
  // The old bug: total merely echoed contacts.length (3).
  assertEquals(first.total, 7);
  assertEquals(first.has_more, true);
  assertEquals(first.next_offset, 3);

  const second = buildContactSearchEnvelope({
    query: "a",
    allContacts: CONTACTS,
    offset: first.next_offset!,
    limit: 3,
    scanTruncated: false,
  });
  assertEquals(second.contacts.length, 3);
  assertEquals(second.has_more, true);
  assertEquals(second.next_offset, 6);

  const third = buildContactSearchEnvelope({
    query: "a",
    allContacts: CONTACTS,
    offset: second.next_offset!,
    limit: 3,
    scanTruncated: false,
  });
  assertEquals(third.contacts.length, 1);
  assertEquals(third.has_more, false);
  assertEquals(third.next_offset, null);
  assertEquals(third.total, 7);
  assertEquals(third.total_is_estimate, false);
});

Deno.test("contact_search pages do not repeat or skip a contact", () => {
  const seen: string[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = buildContactSearchEnvelope({
      query: "a",
      allContacts: CONTACTS,
      offset,
      limit: 2,
      scanTruncated: false,
    });
    for (const c of page.contacts as { email_address: string }[]) {
      seen.push(c.email_address);
    }
    if (!page.has_more) break;
    offset = page.next_offset!;
  }
  assertEquals(seen, CONTACTS.map((c) => c.email_address));
});

Deno.test("a truncated scan reports its total as a floor, not a fact", () => {
  const env = buildContactSearchEnvelope({
    query: "a",
    allContacts: CONTACTS,
    offset: 0,
    limit: 20,
    scanTruncated: true,
  });
  assertEquals(env.total, 7);
  assertEquals(env.total_is_estimate, true);
  assertEquals(env.scan_truncated, true);
  // Paging still ends where the scan ended — the honest answer is "narrow the
  // query", not an offset that leads nowhere.
  assertEquals(env.has_more, false);
  assertEquals(env.next_offset, null);
});

Deno.test("contact_search offset past the end returns an empty final page", () => {
  const env = buildContactSearchEnvelope({
    query: "a",
    allContacts: CONTACTS,
    offset: 99,
    limit: 20,
    scanTruncated: false,
  });
  assertEquals(env.contacts, []);
  assertEquals(env.has_more, false);
  assertEquals(env.next_offset, null);
  assertEquals(env.untrusted_content, true);
});
