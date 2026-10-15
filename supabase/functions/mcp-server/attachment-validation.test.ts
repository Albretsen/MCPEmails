import { decodedBase64ByteLength } from "./attachment-validation.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test("decodedBase64ByteLength returns exact decoded byte counts", () => {
  assertEquals(decodedBase64ByteLength(""), 0, "empty base64");
  assertEquals(decodedBase64ByteLength("YQ=="), 1, "one byte");
  assertEquals(decodedBase64ByteLength("YWJj"), 3, "three bytes");
  assertEquals(decodedBase64ByteLength("Y WJj\n"), 3, "whitespace is permitted");
});

Deno.test("decodedBase64ByteLength rejects malformed or non-canonical base64", () => {
  assertEquals(decodedBase64ByteLength("abc"), null, "missing padding");
  assertEquals(decodedBase64ByteLength("a==="), null, "invalid padded length");
  assertEquals(decodedBase64ByteLength("YQ=a"), null, "padding must be final");
  assertEquals(decodedBase64ByteLength("###="), null, "invalid alphabet");
});

// ── 2026-10-15: no regular expression, so no stack limit ─────────────────────
// The canonical-base64 pattern this function used overflowed V8's stack from
// about 3 MB, turning every larger inline attachment into an internal error.

/** The rule the regex encoded, kept here as the oracle for the scan. */
function oracle(data: string): number | null {
  const clean = data.replace(/[ \t\n\r\v\f]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return null;
  return atob(clean).length;
}

Deno.test("decodedBase64ByteLength agrees with the old canonical rule on small inputs", () => {
  const cases = [
    "", "QQ==", "QUI=", "QUJD", "QUJDRA==", "Q", "QQ", "QQ=", "QQ===", "QUI==", "Q===",
    "QU=I", "QUJD\r\nRA==", " QUJD ", "QUJD!", "QUJ-", "QUJ_", "====", "QUJDRA==QUJD",
    "AAAA/+/+", "SGVsbG8gV29ybGQ=",
  ];
  for (const value of cases) assertEquals(decodedBase64ByteLength(value), oracle(value), JSON.stringify(value));
  for (let n = 0; n < 64; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    const encoded = btoa(String.fromCharCode(...bytes));
    assertEquals(decodedBase64ByteLength(encoded), n, `random ${n} bytes`);
  }
});

Deno.test("decodedBase64ByteLength measures 14 MB of base64 without throwing", () => {
  const big = "QUJD".repeat(3_700_000); // 14.8 MB of text, 11.1 MB decoded
  assertEquals(decodedBase64ByteLength(big), 11_100_000, "14 MB measured");
  assertEquals(decodedBase64ByteLength(big + "!"), null, "14 MB malformed");
});
