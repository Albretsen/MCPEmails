import { assertEquals } from "jsr:@std/assert@1";
import {
  locateOriginal,
  OriginalFacts,
  OriginalLookup,
  OriginalMatch,
  OriginalRef,
  parseOriginalRef,
  replayOutcome,
} from "./original-locator.ts";

const REF: OriginalRef = { rfc_message_id: "abc@example.com", from: "billing@example.com", subject: "Invoice 12" };
const SAME: OriginalFacts = { ...REF };

function lookup(at: Record<string, OriginalFacts>, found: OriginalMatch[]): OriginalLookup & { searches: string[] } {
  const searches: string[] = [];
  return {
    searches,
    read: (id) => Promise.resolve(at[id] ?? null),
    search: (rfc) => {
      searches.push(rfc);
      return Promise.resolve(found);
    },
  };
}

Deno.test("the stored id still names the message: used as is, with no search", async () => {
  const l = lookup({ "INBOX:7": SAME }, []);
  assertEquals(await locateOriginal("INBOX:7", REF, l), { kind: "found", id: "INBOX:7", moved: false });
  assertEquals(l.searches.length, 0);
});

Deno.test("archived or deleted to Trash: one match elsewhere is the message", async () => {
  const l = lookup({}, [{ ...SAME, id: "Archive:3" }]);
  assertEquals(await locateOriginal("INBOX:7", REF, l), { kind: "found", id: "Archive:3", moved: true });
  assertEquals(l.searches, ["abc@example.com"]);
});

Deno.test("gone from every folder: refused", async () => {
  assertEquals(await locateOriginal("INBOX:7", REF, lookup({}, [])), { kind: "gone" });
});

Deno.test("two messages with one Message-ID: refused, even if one looks right", async () => {
  const l = lookup({}, [{ ...SAME, id: "Archive:3" }, { ...SAME, id: "Other:9", subject: "Something else" }]);
  assertEquals(await locateOriginal("INBOX:7", REF, l), { kind: "ambiguous" });
});

Deno.test("the same match reported twice is one match", async () => {
  const l = lookup({}, [{ ...SAME, id: "Archive:3" }, { ...SAME, id: "Archive:3" }]);
  assertEquals(await locateOriginal("INBOX:7", REF, l), { kind: "found", id: "Archive:3", moved: true });
});

Deno.test("one match with a copied Message-ID but another sender is not the message", async () => {
  const l = lookup({}, [{ ...SAME, id: "INBOX:9", from: "someone@example.org" }]);
  assertEquals(await locateOriginal("INBOX:7", REF, l), { kind: "gone" });
});

Deno.test("a stored id that now names another message is not used", async () => {
  const other = { rfc_message_id: "new@example.org", from: "x@example.org", subject: "New" };
  const l = lookup({ "INBOX:7": other }, [{ ...SAME, id: "Archive:3" }]);
  assertEquals(await locateOriginal("INBOX:7", REF, l), { kind: "found", id: "Archive:3", moved: true });
});

Deno.test("no ref recorded: only the stored id can be used", async () => {
  assertEquals(await locateOriginal("INBOX:7", null, lookup({ "INBOX:7": SAME }, [])), {
    kind: "found",
    id: "INBOX:7",
    moved: false,
  });
  assertEquals(await locateOriginal("INBOX:7", null, lookup({}, [{ ...SAME, id: "Archive:3" }])), { kind: "gone" });
});

Deno.test("a mailbox that cannot answer is not read as gone", async () => {
  const l: OriginalLookup = {
    read: () => Promise.reject(new Error("imap_auth_failed")),
    search: () => Promise.resolve([]),
  };
  let thrown = "";
  await locateOriginal("INBOX:7", REF, l).catch((e) => (thrown = e.message));
  assertEquals(thrown, "imap_auth_failed");
});

Deno.test("parseOriginalRef takes only the stored shape", () => {
  assertEquals(parseOriginalRef(REF), REF);
  assertEquals(parseOriginalRef({ rfc_message_id: "" }), null);
  assertEquals(parseOriginalRef("abc"), null);
  assertEquals(parseOriginalRef(null), null);
});

Deno.test("only a succeeded ledger row counts as sent; the rest are never retried", () => {
  assertEquals(replayOutcome("succeeded"), "already_sent");
  assertEquals(replayOutcome("unknown"), "uncertain");
  assertEquals(replayOutcome("failed"), "uncertain");
});
