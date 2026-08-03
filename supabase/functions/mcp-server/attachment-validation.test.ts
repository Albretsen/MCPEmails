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
