// ---------------------------------------------------------------------------
// draft-attachments.test.ts — the pure half of files on a draft: parsing
// ChatGPT's `files`, the guarded download, and what a rebuild carries.
//
// Every URL, filename and byte here is invented. Hosts resolve through an
// injected lookup, so nothing touches the network.
// ---------------------------------------------------------------------------

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  carriedAttachmentsOf,
  cleanMediaType,
  createUploadedFileFetcher,
  fetchableFileUrl,
  parseUploadedFiles,
  UPLOADED_FILE_SCHEMA,
  UploadedFileError,
  uploadedFileName,
} from "./draft-attachments.ts";
import { parseEmail } from "./mime.ts";

const PUBLIC = "93.184.215.14";

/** A lookup that answers every name with the given address. */
const lookupTo = (address: string) => (_host: string) => Promise.resolve([{ address, family: 4 }]);

function bytesResponse(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(bytes, { status, headers });
}

// ── The schema OpenAI's scan checks ─────────────────────────────────────────

Deno.test("the file object schema is exactly the four properties OpenAI's scan requires", () => {
  assertEquals(Object.keys(UPLOADED_FILE_SCHEMA.properties).sort(), [
    "download_url",
    "file_id",
    "file_name",
    "mime_type",
  ]);
  assertEquals([...UPLOADED_FILE_SCHEMA.required], ["download_url", "file_id"]);
  assertEquals(UPLOADED_FILE_SCHEMA.additionalProperties, false);
});

// ── Parsing ─────────────────────────────────────────────────────────────────

Deno.test("files: absent is none; a lone object is a list of one; fields are trimmed", () => {
  assertEquals(parseUploadedFiles("draft_create", undefined), { ok: true, files: [] });
  assertEquals(parseUploadedFiles("draft_create", null), { ok: true, files: [] });
  assertEquals(
    parseUploadedFiles("draft_create", {
      download_url: "https://files.example.com/a?sig=1",
      file_id: " file_1 ",
      file_name: " Angebot.pdf ",
      mime_type: "application/pdf",
    }),
    {
      ok: true,
      files: [{
        download_url: "https://files.example.com/a?sig=1",
        file_id: "file_1",
        file_name: "Angebot.pdf",
        mime_type: "application/pdf",
      }],
    },
  );
});

Deno.test("files: a non-https URL, a missing file_id and too many entries are refused", () => {
  const bad = (raw: unknown) => {
    const out = parseUploadedFiles("draft_create", raw);
    assert(!out.ok, JSON.stringify(raw));
    return out.message;
  };
  assert(bad([{ download_url: "http://files.example.com/a", file_id: "f" }]).includes("files[0].download_url"));
  assert(bad([{ download_url: "https://files.example.com/a" }]).includes("files[0].file_id"));
  assert(bad(["x"]).includes("files[0] must be an object"));
  const many = Array.from({ length: 21 }, () => ({ download_url: "https://a.example.com/", file_id: "f" }));
  assert(bad(many).includes("must not exceed 20"));
});

Deno.test("fetchableFileUrl: https on the default port, no credentials, bounded", () => {
  assertEquals(fetchableFileUrl("https://files.example.com/x"), "https://files.example.com/x");
  assertEquals(fetchableFileUrl("https://files.example.com:443/x"), "https://files.example.com/x");
  assertEquals(fetchableFileUrl("https://files.example.com:8443/x"), null);
  assertEquals(fetchableFileUrl("https://u:p@files.example.com/x"), null);
  assertEquals(fetchableFileUrl("file:///etc/passwd"), null);
  assertEquals(fetchableFileUrl("ftp://files.example.com/x"), null);
  assertEquals(fetchableFileUrl(`https://files.example.com/${"a".repeat(5000)}`), null);
  assertEquals(fetchableFileUrl(42), null);
});

Deno.test("names and types: control characters and separators go, a missing name gets an extension", () => {
  assertEquals(uploadedFileName("Preisliste 2026.xlsx", "application/octet-stream"), "Preisliste 2026.xlsx");
  assertEquals(uploadedFileName("../../etc/passwd", "text/plain"), ".._.._etc_passwd");
  assertEquals(uploadedFileName("a\r\nb.pdf", "application/pdf"), "ab.pdf");
  assertEquals(uploadedFileName(undefined, "application/pdf"), "attachment.pdf");
  assertEquals(uploadedFileName("  ", "application/x-unknown"), "attachment");
  assertEquals(cleanMediaType("Application/PDF; charset=binary"), "application/pdf");
  assertEquals(cleanMediaType("not a type"), null);
  assertEquals(cleanMediaType("text/html\r\nX-Evil: 1"), null);
});

// ── The download ────────────────────────────────────────────────────────────

Deno.test("download: the bytes, base64, with the caller's name and type", async () => {
  const seen: string[] = [];
  const fetcher = createUploadedFileFetcher({
    lookup: lookupTo(PUBLIC),
    fetch: (input) => {
      seen.push(String(input));
      return Promise.resolve(bytesResponse(new Uint8Array([37, 80, 68, 70]), { "content-type": "text/plain" }));
    },
  });
  const file = await fetcher("draft_create", 0, {
    download_url: "https://files.example.com/f1",
    file_id: "file_1",
    file_name: "Rechnung.pdf",
    mime_type: "application/pdf",
  }, 1024);
  assertEquals(file, { filename: "Rechnung.pdf", mime_type: "application/pdf", data: "JVBERg==", size_bytes: 4 });
  assertEquals(seen, ["https://files.example.com/f1"]);
});

Deno.test("download: without a type from the caller the response's is used, then octet-stream", async () => {
  const fetcherWith = (contentType: string | null) =>
    createUploadedFileFetcher({
      lookup: lookupTo(PUBLIC),
      fetch: () =>
        Promise.resolve(bytesResponse(new Uint8Array([1]), contentType ? { "content-type": contentType } : {})),
    });
  const ref = { download_url: "https://files.example.com/f", file_id: "f" };
  assertEquals((await fetcherWith("text/csv; charset=utf-8")("t", 0, ref, 10)).mime_type, "text/csv");
  assertEquals((await fetcherWith("text/csv")("t", 0, ref, 10)).filename, "attachment.csv");
  // A Response with a Uint8Array body gets no content-type of its own.
  assertEquals((await fetcherWith(null)("t", 0, ref, 10)).mime_type, "application/octet-stream");
});

Deno.test("download: a host that resolves to a private address is never fetched", async () => {
  let fetched = 0;
  const fetcher = createUploadedFileFetcher({
    lookup: lookupTo("10.0.0.5"),
    fetch: () => {
      fetched++;
      return Promise.resolve(bytesResponse(new Uint8Array([1])));
    },
  });
  const err = await assertRejects(
    () => fetcher("draft_create", 0, { download_url: "https://internal.example.com/x", file_id: "f" }, 10),
    UploadedFileError,
  );
  assertEquals(err.code, "file_unavailable");
  assertEquals(fetched, 0);
});

Deno.test("download: a redirect is followed only to a URL that passes the same checks", async () => {
  const hops: string[] = [];
  const fetcher = createUploadedFileFetcher({
    lookup: (host) => Promise.resolve([{ address: host === "cdn.example.com" ? PUBLIC : "127.0.0.1", family: 4 }]),
    fetch: (input) => {
      const url = String(input);
      hops.push(url);
      if (url.startsWith("https://files.example.com/")) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://cdn.example.com/x" } }));
      }
      return Promise.resolve(bytesResponse(new Uint8Array([7])));
    },
  });
  // files.example.com resolves to loopback in this lookup, so the FIRST hop is
  // refused; nothing is fetched.
  await assertRejects(
    () => fetcher("t", 0, { download_url: "https://files.example.com/a", file_id: "f" }, 10),
    UploadedFileError,
  );
  assertEquals(hops, []);

  const ok = createUploadedFileFetcher({
    lookup: lookupTo(PUBLIC),
    fetch: (input) => {
      const url = String(input);
      hops.push(url);
      if (url === "https://files.example.com/a") {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/b" } }));
      }
      if (url === "https://files.example.com/b") {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://files.example.com/c" } }));
      }
      return Promise.resolve(bytesResponse(new Uint8Array([7])));
    },
  });
  await assertRejects(
    () => ok("t", 0, { download_url: "https://files.example.com/a", file_id: "f" }, 10),
    UploadedFileError,
    "could not be downloaded",
  );
  assertEquals(hops, ["https://files.example.com/a", "https://files.example.com/b"], "the http hop is not taken");
});

Deno.test("download: the budget is enforced while reading, whatever Content-Length says", async () => {
  const big = new Uint8Array(64);
  const declared = createUploadedFileFetcher({
    lookup: lookupTo(PUBLIC),
    fetch: () => Promise.resolve(bytesResponse(big, { "content-length": "64" })),
  });
  const err = await assertRejects(
    () => declared("draft_create", 2, { download_url: "https://f.example.com/x", file_id: "f", file_name: "big.bin" }, 63),
    UploadedFileError,
  );
  assertEquals(err.code, "attachment_too_large");
  assert(err.message.includes("files[2] ('big.bin')"), err.message);

  const lying = createUploadedFileFetcher({
    lookup: lookupTo(PUBLIC),
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(40));
              controller.enqueue(new Uint8Array(40));
              controller.close();
            },
          }),
          { headers: { "content-length": "1" } },
        ),
      ),
  });
  const lied = await assertRejects(
    () => lying("t", 0, { download_url: "https://f.example.com/x", file_id: "f" }, 63),
    UploadedFileError,
  );
  assertEquals(lied.code, "attachment_too_large");
});

Deno.test("download: a non-200 or a thrown fetch is 'could not be downloaded', never a raw error", async () => {
  for (
    const respond of [
      () => Promise.resolve(new Response("gone", { status: 404 })),
      () => Promise.reject(new TypeError("network down")),
    ]
  ) {
    const fetcher = createUploadedFileFetcher({ lookup: lookupTo(PUBLIC), fetch: respond });
    const err = await assertRejects(
      () => fetcher("draft_update", 0, { download_url: "https://f.example.com/x", file_id: "f" }, 10),
      UploadedFileError,
    );
    assertEquals(err.code, "file_unavailable");
    assert(err.message.startsWith("draft_update: files[0] could not be downloaded"), err.message);
  }
});

// ── What a rebuild carries ──────────────────────────────────────────────────

const CRLF = "\r\n";
const STORED = [
  "From: a@example.com",
  "Subject: Angebot",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="m1"',
  "",
  "--m1",
  'Content-Type: multipart/related; boundary="r1"',
  "",
  "--r1",
  "Content-Type: text/html; charset=UTF-8",
  "",
  '<p>Hallo <img src="cid:Logo@X"></p>',
  "--r1",
  'Content-Type: image/png; name="logo.png"',
  "Content-ID: <logo@x>",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw==",
  "--r1--",
  "--m1",
  'Content-Type: application/pdf; name="angebot.pdf"',
  'Content-Disposition: attachment; filename="angebot.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--m1",
  'Content-Type: text/csv; name="preise.csv"',
  "Content-ID: <unused@x>",
  'Content-Disposition: attachment; filename="preise.csv"',
  "",
  "a;b",
  "--m1--",
  "",
].join(CRLF);

Deno.test("carried: every file, minus a named part the HTML shows inline (cid matched case-insensitively)", () => {
  const carried = carriedAttachmentsOf(parseEmail(STORED));
  assertEquals(carried.count, 2);
  assertEquals(carried.inlineImages, 1);
  assertEquals(carried.bytes, 9 + 3);
  const files = carried.encode();
  assertEquals(files.map((f) => f.filename), ["angebot.pdf", "preise.csv"]);
  assertEquals(files[0], { filename: "angebot.pdf", mime_type: "application/pdf", data: "JVBERi0xLjQK" });
  assertEquals(atob(files[1].data), "a;b");
});

Deno.test("carried: a message with no files carries nothing", () => {
  const carried = carriedAttachmentsOf(parseEmail(
    ["Subject: x", "Content-Type: text/plain", "", "hi", ""].join(CRLF),
  ));
  assertEquals([carried.count, carried.bytes, carried.inlineImages, carried.encode()], [0, 0, 0, []]);
});
