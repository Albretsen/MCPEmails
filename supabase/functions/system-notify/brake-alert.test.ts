// Run: deno test --node-modules-dir=none --allow-read supabase/functions/system-notify/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type BrakeAlertDb, isRepeatBrakeAlert } from "./brake-alert.ts";

type Ev = { id: string; event_type: string; created_at: string; payload: Record<string, unknown> };

/** A tiny in-memory stand-in for the PostgREST filters brake-alert.ts uses. */
function fakeDb(events: Ev[]): BrakeAlertDb {
  return {
    from: () => ({
      select: () => {
        const filters: ((e: Ev) => boolean)[] = [];
        let max = Infinity;
        const field = (e: Ev, column: string): unknown =>
          column.startsWith("payload->>") ? e.payload[column.slice(10)] : (e as Record<string, unknown>)[column];
        const rows = () => events.filter((e) => filters.every((f) => f(e))).slice(0, max);
        const q = {
          eq(c: string, v: unknown) {
            filters.push((e) => field(e, c) === v);
            return q;
          },
          lt(c: string, v: unknown) {
            filters.push((e) => String(field(e, c)) < String(v));
            return q;
          },
          gt(c: string, v: unknown) {
            filters.push((e) => String(field(e, c)) > String(v));
            return q;
          },
          limit(n: number) {
            max = n;
            return q;
          },
          maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
          then: (ok: (a: { data: unknown; error: null }) => unknown) =>
            Promise.resolve({ data: rows(), error: null }).then(ok),
        };
        return q as unknown as ReturnType<ReturnType<BrakeAlertDb["from"]>["select"]>;
      },
    }),
  };
}

const ev = (id: string, at: string, inbox = "inbox-a", brake = "fanout_hold"): Ev => ({
  id,
  event_type: "outbound.brake_tripped",
  created_at: at,
  payload: { inbox_id: inbox, brake },
});

Deno.test("the first trip for an inbox is emailed, later ones within 24 hours are not", async () => {
  const events = [
    ev("e1", "2026-11-17T10:06:10.000Z"),
    ev("e2", "2026-11-17T11:16:12.000Z"),
    ev("e3", "2026-11-17T11:16:30.000Z"),
  ];
  const db = fakeDb(events);
  assertEquals(await isRepeatBrakeAlert(db, "e1", events[0].payload), false);
  assertEquals(await isRepeatBrakeAlert(db, "e2", events[1].payload), true);
  assertEquals(await isRepeatBrakeAlert(db, "e3", events[2].payload), true);
});

Deno.test("trips seconds apart do not silence each other: the earlier one alerts", async () => {
  const events = [ev("a", "2026-11-17T11:16:12.000Z"), ev("b", "2026-11-17T11:16:30.000Z")];
  const db = fakeDb(events);
  assertEquals(await isRepeatBrakeAlert(db, "a", events[0].payload), false);
  assertEquals(await isRepeatBrakeAlert(db, "b", events[1].payload), true);
});

Deno.test("another inbox, another brake, or a trip over 24 hours later alerts again", async () => {
  const events = [
    ev("x1", "2026-11-16T10:00:00.000Z"),
    ev("x2", "2026-11-16T11:00:00.000Z", "inbox-b"),
    ev("x3", "2026-11-16T12:00:00.000Z", "inbox-a", "provider_refusal_pause"),
    ev("x4", "2026-11-17T10:00:01.000Z"),
  ];
  const db = fakeDb(events);
  for (const e of events.slice(1)) assertEquals(await isRepeatBrakeAlert(db, e.id, e.payload), false, e.id);
});

Deno.test("a payload without ids, or an unreadable event, still alerts", async () => {
  const db = fakeDb([]);
  assertEquals(await isRepeatBrakeAlert(db, "missing", { inbox_id: "inbox-a", brake: "fanout_hold" }), false);
  assertEquals(await isRepeatBrakeAlert(db, "missing", {}), false);
});

Deno.test("system-notify checks for a repeat before building the brake email", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const check = source.indexOf("await isRepeatBrakeAlert(");
  assert(
    check > 0 && check < source.indexOf("const template = await buildTemplate("),
    "checked before the email is built",
  );
  assert(/markProcessed\("failed", BRAKE_ALERT_REPEAT_ERROR\)/.test(source), "the event row is kept and marked");
});
