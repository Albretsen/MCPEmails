// ---------------------------------------------------------------------------
// Retired argument names (`unread_only`, `scheduled_send_id`) are no longer
// advertised but must keep working for clients holding a cached schema, and
// the value translation must preserve what the caller meant.
//
// Run: deno test supabase/functions/mcp-server/
// ---------------------------------------------------------------------------

import { assertEquals } from "jsr:@std/assert@1";
import { normalizeArgumentAliases, retiredArgumentNames } from "./argument-aliases.ts";

Deno.test("email_read: unread_only: true becomes unread: true", () => {
  const args: Record<string, unknown> = { action: "list", unread_only: true };
  const applied = normalizeArgumentAliases("email_read", args);
  assertEquals(args, { action: "list", unread: true });
  assertEquals(applied, [{ from: "unread_only", to: "unread" }]);
});

Deno.test("email_read: unread_only: false meant 'no filter', so it becomes absence, never unread: false", () => {
  const args: Record<string, unknown> = { action: "list", unread_only: false, limit: 5 };
  normalizeArgumentAliases("email_read", args);
  assertEquals(args, { action: "list", limit: 5 });
  assertEquals("unread" in args, false);
});

Deno.test("email_read: the canonical unread wins when both are sent", () => {
  const args: Record<string, unknown> = { action: "list", unread_only: true, unread: false };
  normalizeArgumentAliases("email_read", args);
  assertEquals(args, { action: "list", unread: false });
});

Deno.test("email_read: a non-boolean unread_only is carried over so validation still refuses it", () => {
  const args: Record<string, unknown> = { action: "list", unread_only: "yes" };
  normalizeArgumentAliases("email_read", args);
  assertEquals(args, { action: "list", unread: "yes" });
});

Deno.test("schedule: scheduled_send_id becomes id", () => {
  const args: Record<string, unknown> = {
    action: "cancel",
    scheduled_send_id: "c91e0b2a-7f3d-4a18-9c44-2b6e1d8f0a55",
  };
  const applied = normalizeArgumentAliases("schedule", args);
  assertEquals(args, { action: "cancel", id: "c91e0b2a-7f3d-4a18-9c44-2b6e1d8f0a55" });
  assertEquals(applied, [{ from: "scheduled_send_id", to: "id" }]);
});

Deno.test("schedule: id wins over scheduled_send_id when both are sent", () => {
  const args: Record<string, unknown> = { action: "cancel", id: "a", scheduled_send_id: "b" };
  normalizeArgumentAliases("schedule", args);
  assertEquals(args, { action: "cancel", id: "a" });
});

Deno.test("arguments without a retired name are untouched and report nothing", () => {
  const args: Record<string, unknown> = { action: "search", unread: true, from: "alice" };
  const applied = normalizeArgumentAliases("email_read", args);
  assertEquals(applied, []);
  assertEquals(args, { action: "search", unread: true, from: "alice" });
});

Deno.test("tools without aliases are untouched", () => {
  const args: Record<string, unknown> = { action: "send", unread_only: true };
  assertEquals(normalizeArgumentAliases("email_compose", args), []);
  assertEquals(args, { action: "send", unread_only: true });
  assertEquals(retiredArgumentNames("email_compose"), []);
});

Deno.test("the retired names are exactly the two the schemas stopped advertising", () => {
  assertEquals(retiredArgumentNames("email_read"), ["unread_only"]);
  assertEquals(retiredArgumentNames("schedule"), ["scheduled_send_id"]);
});
