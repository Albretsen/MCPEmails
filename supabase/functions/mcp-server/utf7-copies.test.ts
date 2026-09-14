import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

// NOTE: this test touches the filesystem, so the suite must be run with
// --allow-read (the project runs it as `deno test --allow-all`). Without the
// flag it fails with NotCapable rather than skipping, and that is deliberate,
// exactly as for "the three copies of the character class agree" in
// text-safety.test.ts: a drift check that quietly does not run is worse than no
// drift check, because it reads as green while the copies diverge.
Deno.test("the two copies of the modified-UTF-7 codec agree", async () => {
  // utf7.ts here and apps/web/src/lib/email/utf7.ts hold the same code because
  // they run in two runtimes that cannot import from one another: this function
  // is deployed on its own with `supabase functions deploy` and bundles only
  // what lives under supabase/functions/, and no edge function in this repo
  // imports anything from outside that tree. packages/ holds the published npm
  // CLI, not shared source. So the repo's existing answer applies — duplicate,
  // and fail the build when the duplicates stop matching.
  //
  // If they drift, a folder name is human-readable on one surface and a raw
  // wire string on the other, which is the bug both copies exist to close.
  //
  // Everything from the first line of code to the end of the file must be
  // byte-identical. The header comment above it is the only part either file
  // writes for itself, because each has to explain its own side of the copy.
  const ANCHOR = "const ALPHABET =";
  const here = new URL(".", import.meta.url).pathname;
  const files = [
    `${here}utf7.ts`,
    `${here}../../../apps/web/src/lib/email/utf7.ts`,
  ];
  const bodies: string[] = [];
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    const at = source.indexOf(ANCHOR);
    assertNotEquals(at, -1, `${file} no longer contains "${ANCHOR}" — the copies have drifted`);
    bodies.push(source.slice(at));
  }
  assert(bodies[0].length > 0, "the codec body is empty, which means the anchor moved");
  assertEquals(
    bodies[0],
    bodies[1],
    "supabase/functions/mcp-server/utf7.ts and apps/web/src/lib/email/utf7.ts have drifted; make them identical again",
  );
});
