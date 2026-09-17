#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The draft body: what is dirty, and where the signature starts.
//
//   node harness/draft-body.test.mjs
//
// Same shape and the same rules as harness/state-machine.mjs, which is the
// convention this package already has: no test runner is added, `src/` is
// bundled with esbuild (already present via vite) and the SHIPPED functions are
// driven directly. Nothing here is reimplemented, so it cannot drift from the
// code that runs in the card without failing.
//
// It is a separate file from state-machine.mjs because that one is a scripted
// HOST — it exists to drive postMessage state transitions — and none of this
// needs a host at all. These are pure functions over a string.
//
// ── What is under test ─────────────────────────────────────────────────────
// Three defects, all of which shipped:
//
//   1. `dirty` compared the textarea's value to the stored body byte for byte.
//      A `<textarea>` normalises CRLF to LF, so on a body written by a real mail
//      client the FIRST keystroke made every line differ. `dirty` could never go
//      back to false, Save stayed enabled and armed, and the patch that went out
//      carried the whole body — which made the server regenerate the draft's
//      HTML part from the plain text. Formatting lost on a draft nobody edited.
//   2. `splitBody` documented "the LAST separator wins" and implemented the
//      first one it found.
//   3. `splitBody` matched `\n-- \n` only, so it never fired on a CRLF body,
//      which is every draft written by a real mail client.
//
// Contract clause C4 is the invariant that outranks all three:
// `joinBody(splitBody(t)) === t`, byte-exactly, for every input. A split that
// "normalises" would be a regression, not a fix.
//
// ── And two rules that were correct but undocumented ───────────────────────
// Added in round 2, after a verification pass found the code and its own
// comments disagreeing about them:
//
//   7. A separator needs a line ending on BOTH sides. Only the leading half was
//      written down, so `"a\n-- "` not splitting looked like an oversight.
//      Pinned here in both directions so nobody "fixes" it.
//   8. The signature pin is dropped, not maintained, once the split stops
//      describing it. `applyMessageEdit` is the rule; a pin the code has
//      already rejected can otherwise revalidate at a boundary `splitBody`
//      would never draw.
// ---------------------------------------------------------------------------

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const OUT = resolve(appRoot, "dist/draft-body.bundle.mjs");

// ---- tiny harness -----------------------------------------------------------

const groups = [];
let current = null;

function group(name) {
  current = { name, checks: [] };
  groups.push(current);
}

/** Object.is, so a stray NaN or -0 cannot pass as equal. */
function expect(label, actual, wanted) {
  current.checks.push({ label, actual, wanted, ok: Object.is(actual, wanted) });
}

/** Readable in a failure line: "\r\n" beats an invisible carriage return. */
const show = (s) => JSON.stringify(s);

// ---- the corpus -------------------------------------------------------------

/**
 * Bodies that must round-trip. Deliberately hostile, and deliberately NOT only
 * the tidy LF shapes the split was written against.
 */
function corpus() {
  const bodies = [
    // The ordinary case, and the one the fixture ships.
    "Hi,\n\nHow are you?\n\nBest,\nAsgeir\n\n-- \nAsgeir Albretsen\nFounder\nmcpemails.com",
    "No signature here at all.",
    // Empty and short. `""` has no separator; `"-"`, `"--"` and `"\n"` are each
    // one character away from being one.
    "",
    "-",
    "--",
    "\n",
    "\r",
    "\r\n",
    "-- ",
    // A separator and nothing else. Both halves are the empty string, which is
    // the case an "if (!message) return the whole text" shortcut gets wrong.
    "\n-- \n",
    "\r\n-- \r\n",
    "\r-- \r",
    // Separator at one edge or the other.
    "-- \nleading separator only",
    "trailing separator\n-- \n",
    "trailing separator\r\n-- \r\n",
    // Two separators: the tie-break case.
    "two\n-- \nblocks\n-- \nlast one wins",
    "two\r\n-- \r\nblocks\r\n-- \r\nlast one wins",
    // A signature that itself carries a second separator. The boundary the user
    // sees moves; the bytes must not.
    "message\n-- \nAsgeir\n-- \nsent from a phone",
    "message\r\n-- \r\nAsgeir\r\n--\r\nsent from a phone",
    // The sloppy form, and `--` used as prose.
    "sloppy\n--\nseparator",
    "sloppy\r\n--\r\nseparator",
    "a line of --\nin prose\n\n-- \nreal sig",
    "a line of --\r\nin prose\r\n\r\n-- \r\nreal sig",
    // Adjacent and overlapping separators, where a global regex scan would eat
    // the line ending that opens the next one.
    "a\n--\n-- \nsig",
    "a\r\n--\r\n-- \r\nsig",
    "\n-- \n\n-- \n",
    // Whitespace-only and newline-only.
    "\n\n\n",
    "\r\n\r\n\r\n",
    "   \n\t\n",
    // Mixed endings in one body: what a CRLF draft looks like after a textarea
    // has been anywhere near part of it.
    "line one\r\nline two\n-- \r\nsig",
    "quoted\r\n> --\r\nnot a separator\n-- \nsig",
    // Non-ASCII, astral plane, and a lone surrogate's worth of trouble.
    "unicode ✉️ and CRLF\r\n-- \r\nsig",
    "emoji 👋🏽 then\n-- \n👋",
    " nbsp\n-- \n​zero width",
    // Near-misses that must NOT be treated as separators.
    "not a separator: ---\nstill not\n----\nnope",
    "trailing space after dashes: \n--  \nstill prose",
    "no leading newline -- \njust prose",
  ];

  // Every LF body re-encoded as CRLF and as CR, so each shape is exercised in
  // all three conventions rather than only the one it was typed in.
  const widened = [];
  for (const b of bodies) {
    widened.push(b);
    const lf = b.replace(/\r\n|\r/g, "\n");
    widened.push(lf.replace(/\n/g, "\r\n"));
    widened.push(lf.replace(/\n/g, "\r"));
  }
  return [...new Set(widened)];
}

// ---- the tests --------------------------------------------------------------

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  await build({
    // The card's own modules, not copies. DraftEditor.tsx is pulled in for
    // `draftPatch`, which is the function the Save button and the teardown
    // saver both go through.
    stdin: {
      contents:
        'export { splitBody, joinBody, normalizeEol, bodyTextChanged } from "./src/format";\n' +
        'export { draftPatch, signaturePreview, pinnedSplit, applyMessageEdit }' +
        ' from "./src/components/DraftEditor";\n',
      resolveDir: appRoot,
      sourcefile: "draft-body-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: OUT,
  });
  const mod = await import(pathToFileURL(OUT).href);

  // ── 1. C4: the round trip, over the hostile corpus ────────────────────────
  // The invariant everything else is allowed to move under. If a split ever
  // normalises a line ending instead of slicing, this is what catches it.
  group("C4: joinBody(splitBody(t)) is byte-exactly t");
  const bodies = corpus();
  let roundTripFailures = 0;
  for (const body of bodies) {
    if (mod.joinBody(mod.splitBody(body)) !== body) {
      roundTripFailures++;
      expect(`round trip ${show(body)}`, mod.joinBody(mod.splitBody(body)), body);
    }
  }
  expect(`all ${bodies.length} bodies round-trip`, roundTripFailures, 0);
  // And the pieces really are slices of the input, not rebuilt strings: a split
  // whose message is byte-equal but whose separator was "canonicalised" would
  // still round-trip wrong, so the concatenation identity is asserted directly.
  for (const body of bodies) {
    const s = mod.splitBody(body);
    const rebuilt =
      s.separator === null ? s.message : s.message + s.separator + s.signature;
    if (rebuilt !== body) expect(`concatenates back ${show(body)}`, rebuilt, body);
  }
  expect("the split never invents bytes", true, true);

  // ── 2. The CRLF body a textarea has normalised is NOT dirty ───────────────
  // The primary defect, and the data-loss one. `stored` is what the server sent;
  // `typed` is what the DOM hands back after the user pressed a key and undid
  // it. Byte-different, content-identical: no patch may go out.
  group("a CRLF body normalised by the textarea produces no patch");
  const storedCrlf = "alpha\r\nbeta\r\n-- \r\nSig";
  const textareaValue = storedCrlf.replace(/\r\n|\r/g, "\n");
  expect("the textarea really did change the bytes", textareaValue === storedCrlf, false);
  expect(
    "the same content, by the shipped comparison",
    mod.bodyTextChanged(textareaValue, storedCrlf),
    false,
  );

  const server = {
    to: ["dana@northwind.example"],
    cc: [],
    bcc: [],
    subject: "Q3 numbers",
    bodyText: storedCrlf,
    typed: { to: "", cc: "", bcc: "" },
  };
  const touched = { ...server, bodyText: textareaValue };
  const noPatch = mod.draftPatch(touched, server);
  expect("no body_text", "body_text" in noPatch, false);
  expect("no patch at all", Object.keys(noPatch).length, 0);
  // Which is what `dirty`, the Save button's `disabled` and the teardown saver
  // all read. DraftEditor: `dirty = Object.keys(patch).length > 0`.
  expect("so the card is not dirty", Object.keys(noPatch).length > 0, false);

  // Bare CR too (classic Mac, and what some IMAP servers hand back).
  expect(
    "a bare-CR body is not dirty either",
    Object.keys(
      mod.draftPatch({ ...server, bodyText: "alpha\nbeta\n-- \nSig" }, { ...server, bodyText: "alpha\rbeta\r-- \rSig" }),
    ).length,
    0,
  );
  // And the normaliser is comparison-only: it must not be reachable from
  // anything that stores or sends.
  expect("normalizeEol folds CRLF", mod.normalizeEol("a\r\nb"), "a\nb");
  expect("normalizeEol folds bare CR", mod.normalizeEol("a\rb"), "a\nb");
  expect("normalizeEol leaves LF alone", mod.normalizeEol("a\nb"), "a\nb");

  // ── 3. A real edit still produces a patch ─────────────────────────────────
  // The negative control. Without it, test 2 would also pass if the card had
  // simply stopped sending bodies.
  group("a genuine one-character edit still patches");
  const edited = { ...server, bodyText: textareaValue + "!" };
  const realPatch = mod.draftPatch(edited, server);
  expect("body_text is sent", "body_text" in realPatch, true);
  expect("and it is exactly what is on screen", realPatch.body_text, textareaValue + "!");
  expect("nothing else is sent", Object.keys(realPatch).join(","), "body_text");
  // One character removed is an edit too, and one character changed in the
  // middle of a CRLF body must survive the normalisation.
  expect(
    "a deletion patches",
    "body_text" in mod.draftPatch({ ...server, bodyText: "alpha\nbet\n-- \nSig" }, server),
    true,
  );
  expect(
    "a character changed mid-body patches",
    "body_text" in mod.draftPatch({ ...server, bodyText: "alphb\nbeta\n-- \nSig" }, server),
    true,
  );
  // A line ending ADDED is a real edit: same visible characters, one more line.
  expect(
    "a new blank line patches",
    "body_text" in mod.draftPatch({ ...server, bodyText: "alpha\n\nbeta\n-- \nSig" }, server),
    true,
  );
  // The other fields are untouched by any of this.
  expect(
    "the subject still patches",
    mod.draftPatch({ ...touched, subject: "Q4 numbers" }, server).subject,
    "Q4 numbers",
  );
  expect(
    "a recipient still patches",
    mod.draftPatch({ ...touched, to: ["ops@northwind.example"] }, server).to?.[0],
    "ops@northwind.example",
  );

  // ── 4. The split fires on a CRLF body ─────────────────────────────────────
  // Defect 3. Before the fix this found nothing at all, so the signature stayed
  // in the message box for exactly the drafts the feature was built for.
  group("the signature split fires on CRLF, LF and CR");
  const crlf = mod.splitBody("Hi Dana,\r\n\r\nNumbers attached.\r\n\r\n-- \r\nDemo User\r\nMCP Emails");
  expect("a separator was found", crlf.separator, "\r\n-- \r\n");
  expect("the message stops before it", crlf.message, "Hi Dana,\r\n\r\nNumbers attached.\r\n");
  expect("the signature starts after it", crlf.signature, "Demo User\r\nMCP Emails");
  // The full CRLF form is taken, not the `\n-- \r\n` that also matches one
  // character later. A stray `\r` welded to the end of the message would be
  // invisible on screen and would go out in the next real save.
  expect("no stray CR at the end of the message", crlf.message.endsWith("\r\n"), true);

  const cr = mod.splitBody("Hi Dana,\r\r-- \rDemo User");
  expect("CR-only: a separator was found", cr.separator, "\r-- \r");
  expect("CR-only: message", cr.message, "Hi Dana,\r");
  expect("CR-only: signature", cr.signature, "Demo User");

  const lf = mod.splitBody("Hi Dana,\n\n-- \nDemo User");
  expect("LF still works", lf.separator, "\n-- \n");
  expect("LF: signature", lf.signature, "Demo User");

  const sloppyCrlf = mod.splitBody("Hi\r\n--\r\nDemo User");
  expect("the sloppy form on CRLF", sloppyCrlf.separator, "\r\n--\r\n");
  expect("the sloppy form's signature", sloppyCrlf.signature, "Demo User");

  // Mixed, which is what a half-retyped CRLF draft looks like.
  const mixed = mod.splitBody("typed here\nstored there\r\n-- \r\nSig");
  expect("mixed endings still split", mixed.separator, "\r\n-- \r\n");
  expect("mixed: signature", mixed.signature, "Sig");

  // Still no separator when there is none, on any convention.
  expect("no separator on CRLF prose", mod.splitBody("just\r\nprose").separator, null);
  expect("no signature on CRLF prose", mod.splitBody("just\r\nprose").signature, null);
  expect("--- is not a separator", mod.splitBody("a\r\n---\r\nb").separator, null);

  // ── 5. The tie-break: the LAST separator wins ─────────────────────────────
  // Defect 2. The comment always claimed this; the code returned on the first
  // form it found. The rule is pinned here so the two cannot drift apart again.
  //
  // Why last: a line of exactly `--` is legal prose, and when one turns up the
  // signature is still the final block. Getting it wrong late dims a trailing
  // paragraph; getting it wrong early collapses the whole rest of the message
  // behind a one-line preview, which is the failure that looks like data loss.
  group("the tie-break: the last separator wins");
  const tie = mod.splitBody("Hi\n-- \nAsgeir\n--\nPS");
  expect("split at the LAST separator, not the first", tie.message, "Hi\n-- \nAsgeir");
  expect("which is the sloppy one here", tie.separator, "\n--\n");
  expect("signature", tie.signature, "PS");

  const tieCrlf = mod.splitBody("Hi\r\n-- \r\nAsgeir\r\n--\r\nPS");
  expect("same on CRLF", tieCrlf.message, "Hi\r\n-- \r\nAsgeir");
  expect("same on CRLF: signature", tieCrlf.signature, "PS");

  // Overlapping separators, where the line ending that closes the first one
  // also opens the second. A single global regex scan gets this wrong.
  const overlap = mod.splitBody("a\n--\n-- \nsig");
  expect("the later, overlapping separator wins", overlap.message, "a\n--");
  expect("overlap: separator", overlap.separator, "\n-- \n");
  expect("overlap: signature", overlap.signature, "sig");

  // `--` inside prose above a real signature must not win.
  const prose = mod.splitBody("a line of --\nin prose\n\n-- \nreal sig");
  expect("prose dashes do not win", prose.signature, "real sig");

  // A body that OPENS with a separator has no leading line ending, so it is all
  // message. Unchanged, and the conservative reading.
  expect("a body opening with -- is all message", mod.splitBody("-- \nsig").separator, null);

  // ── 6. The collapsed preview, now that CRLF signatures reach it ───────────
  // Not a byte problem — the preview is display only — but it is newly
  // REACHABLE. Before the separator list learned CRLF and CR, `splitBody` never
  // fired on a body from a real mail client, so `signaturePreview` could only
  // ever be handed an LF signature. It splits the signature into lines, and
  // splitting on LF alone left a stray CR welded to the first line, and on a
  // bare-CR signature returned the whole thing as ONE line, so the row that
  // exists to show one line rendered all of them.
  group("the collapsed signature preview handles every line ending");
  expect("LF: first line and a count", mod.signaturePreview("Demo User\nMCP Emails"), "Demo User + 1 more line");
  expect("CRLF: no stray CR", mod.signaturePreview("Demo User\r\nMCP Emails"), "Demo User + 1 more line");
  expect("CR: still two lines", mod.signaturePreview("Demo User\rMCP Emails"), "Demo User + 1 more line");
  expect("CRLF, one line only", mod.signaturePreview("Demo User\r\n"), "Demo User");
  expect("blank lines do not count", mod.signaturePreview("\r\n\r\nDemo User\r\n\r\n"), "Demo User");
  expect("nothing to show", mod.signaturePreview("\r\n \r\n"), "Signature");
  expect("three lines on CR", mod.signaturePreview("A\rB\rC"), "A + 2 more lines");

  // ── 7. A separator needs a line ending on BOTH sides ──────────────────────
  // Not a defect: a deliberate rule that was only half documented, which is how
  // it would have been "fixed" by someone reading the code as an oversight. The
  // leading half was written down; the trailing half was not, so `"a\n-- "` —
  // dashes at the very end of a body, no newline after them — quietly did not
  // split and nothing said that was on purpose.
  //
  // Both halves fail toward "it is all message", which is the reading that never
  // collapses text behind a one-line preview. The trailing rule is also what
  // keeps the line you are typing from being torn out of the message box the
  // instant you finish the dashes: the split arrives with the next Enter.
  group("a separator needs a line ending on BOTH sides");
  // Trailing: the body ENDS at the dashes.
  expect("`-- ` at the very end does not split", mod.splitBody("a\n-- ").separator, null);
  expect("`--` at the very end does not split", mod.splitBody("a\n--").separator, null);
  expect("CRLF: `-- ` at the very end", mod.splitBody("a\r\n-- ").separator, null);
  expect("CR: `-- ` at the very end", mod.splitBody("a\r-- ").separator, null);
  expect("the whole body is the message", mod.splitBody("a\n-- ").message, "a\n-- ");
  expect("and there is no signature", mod.splitBody("a\n-- ").signature, null);
  // One more line ending and it does split, which is what makes the rule a rule
  // about the trailing EOL and not about the dashes.
  expect("one Enter later it splits", mod.splitBody("a\n-- \n").separator, "\n-- \n");
  expect("and the signature is empty, not absent", mod.splitBody("a\n-- \n").signature, "");
  // Leading: the body OPENS with the dashes. Already documented, pinned here so
  // the two halves of the rule live together.
  expect("`-- \\n` at index 0 does not split", mod.splitBody("-- \nsig").separator, null);
  expect("nor does `--\\n` at index 0", mod.splitBody("--\nsig").separator, null);
  // A trailing separator that is NOT the last one still splits at the last
  // COMPLETE one: the incomplete trailing candidate is simply not a candidate.
  const halfTyped = mod.splitBody("msg\n-- \nAsgeir\n-- ");
  expect("an incomplete trailing candidate is ignored", halfTyped.separator, "\n-- \n");
  expect("so the earlier complete one wins", halfTyped.signature, "Asgeir\n-- ");
  expect("and it still round-trips", mod.joinBody(halfTyped), "msg\n-- \nAsgeir\n-- ");

  // ── 8. The pin is dropped when the split no longer describes it ───────────
  // `applyMessageEdit` is one keystroke in the message box: the new body text,
  // and what becomes of the boundary the signature box pinned.
  //
  // The rule under test is the second half. It used to be an unconditional
  // `{ ...pin, messageLen: v.length }`, which kept maintaining a pin
  // `pinnedSplit` had already rejected for that text.
  group("a pin the split no longer describes is dropped, not maintained");
  // The ordinary case first: a LIVE pin is carried and stays live.
  const liveText = "msg\r\n-- \r\nSig";
  const liveSplit = mod.splitBody(liveText);
  const livePin = { messageLen: liveSplit.message.length, separator: liveSplit.separator };
  const typed = mod.applyMessageEdit(liveSplit, livePin, "msg!");
  expect("the body is joined byte-exactly", typed.bodyText, "msg!\r\n-- \r\nSig");
  expect("the pin moves with the message", typed.pin?.messageLen, 4);
  expect("and keeps its separator", typed.pin?.separator, "\r\n-- \r\n");
  expect(
    "so it still validates against the new text",
    mod.pinnedSplit(typed.bodyText, typed.pin)?.signature,
    "Sig",
  );
  // Deleting the whole message keeps the pin at 0 rather than dropping it.
  const emptied = mod.applyMessageEdit(liveSplit, livePin, "");
  expect("an emptied message keeps the pin", emptied.pin?.messageLen, 0);
  expect("emptied: the body is just separator + signature", emptied.bodyText, "\r\n-- \r\nSig");

  // Now the DEAD pin. `{ messageLen: 5, separator: "\r\n--\r" }` does not
  // describe "aa\r\n--\r\nsig" — slice(5, 10) is "-\r\nsi" — so this render fell
  // back to `splitBody`, whose boundary is a different one.
  const deadText = "aa\r\n--\r\nsig";
  const deadPin = { messageLen: 5, separator: "\r\n--\r" };
  expect("the pin really is dead", mod.pinnedSplit(deadText, deadPin), null);
  const deadSplit = mod.splitBody(deadText);
  expect("so the render used splitBody", deadSplit.separator, "\r\n--\r\n");
  const afterDead = mod.applyMessageEdit(deadSplit, deadPin, "b");
  expect("the body still joins byte-exactly", afterDead.bodyText, "b\r\n--\r\nsig");
  expect("and the dead pin is dropped", afterDead.pin, null);
  // WHY THAT MATTERS. Under the old rule the dead pin came out as
  // { messageLen: 1, separator: "\r\n--\r" }, and against the SHORTER body that
  // validates again — one byte short of the real separator. The boundary the
  // signature box would then draw is not the one `splitBody` draws, and the
  // signature gains a leading blank line out of nowhere. Nothing is lost (the
  // bytes still join back), but it is a wrong boundary revived from state the
  // code had already discarded. This is the assertion that fails before the fix.
  const oldRulePin = { ...deadPin, messageLen: "b".length };
  const resurrected = mod.pinnedSplit(afterDead.bodyText, oldRulePin);
  expect("the old rule's pin would have come back to life", resurrected !== null, true);
  expect("at a boundary splitBody does not draw", resurrected?.separator, "\r\n--\r");
  expect("with a stray newline in the signature", resurrected?.signature, "\nsig");
  expect(
    "whereas the dropped pin falls back to splitBody",
    mod.splitBody(afterDead.bodyText).signature,
    "sig",
  );
  // A pin against a split with no separator at all is dropped too: there is no
  // boundary to pin, and `joinBody` returns the message alone.
  const noSep = mod.splitBody("just prose");
  const afterNoSep = mod.applyMessageEdit(noSep, livePin, "just prose!");
  expect("no separator: the body is the message", afterNoSep.bodyText, "just prose!");
  expect("no separator: no pin survives", afterNoSep.pin, null);
  // And the whole corpus: whatever the pin was, the edit never invents bytes.
  let joinFailures = 0;
  for (const body of bodies) {
    const s = mod.splitBody(body);
    const out = mod.applyMessageEdit(s, null, s.message);
    if (out.bodyText !== body) joinFailures++;
  }
  expect(`a no-op message edit is the identity on all ${bodies.length} bodies`, joinFailures, 0);

  // ---- report ---------------------------------------------------------------

  let failed = 0;
  for (const g of groups) {
    const bad = g.checks.filter((c) => !c.ok);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "}  ${g.name}`);
    for (const c of bad) {
      console.log(`        ${c.label}: got ${show(c.actual)}, want ${show(c.wanted)}`);
    }
  }
  const total = groups.reduce((n, g) => n + g.checks.length, 0);
  console.log(`\n${total - failed}/${total} checks passed (${bodies.length} bodies in the corpus)`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
