// ---------------------------------------------------------------------------
// The display name `contact_search` returns.
//
// A live functional test on 2026-09-20 (F-07) asked for one contact and got
// this back:
//
//   contact_search {query:"no", limit:1}
//   -> "display_name":"=?UTF-8?Q?Karin_p=C3=A5_Teknikkdeler?="
//
// That is an RFC 2047 encoded-word, shipped raw. Every OTHER surface decodes:
// `email_read` runs subjects and address names through `decodeEncodedWords`,
// and the IMAP list/search summaries do the same via `decodeEnvelopeSubject` /
// `decodeEnvelopeAddress`, which is why the same Norwegian, Arabic, Hebrew, CJK
// and emoji names came back correct everywhere else in the run. Only the
// contact aggregator, whose `display_name` exists for no purpose but to be
// READ by a human or a model, folded the ENVELOPE personal-name field verbatim.
//
// Two consequences, not one. The obvious one is the gibberish label. The other
// is the query filter: `foldContactEntries` keeps an address only when the
// query matches its email or its name, and matching "på" against
// "p=C3=A5" fails, so an encoded correspondent was unfindable by their own
// name. Decoding at ingestion fixes both; decoding at the last moment before
// serialisation would have fixed only the first.
//
// ── Why the strip is here and not only downstream ──────────────────────────
// `executeSearchContacts` already runs the finished list through
// `neutralizeMaybe`, and it runs AFTER this, so the ordering was never wrong.
// It is repeated here because decoding is exactly the operation that can
// REINTRODUCE what neutralisation removes: an encoded-word is opaque bytes
// until it is decoded, so `=?UTF-8?Q?Karin=E2=80=AE...?=` carries a
// RIGHT-TO-LEFT OVERRIDE that no strip over the encoded form can see. The
// server documents that display names arrive stripped of invisible and
// bidi-override characters; keeping the strip attached to the decode is what
// makes that true at the point the risk is created, rather than at a later call
// site a future refactor might reorder. `neutralizeText` is idempotent, so
// running it twice costs one pass over a short string.
// ---------------------------------------------------------------------------

import { decodeEncodedWords } from "./mime.ts";
import { neutralizeText } from "./text-safety.ts";

/**
 * Decode one correspondent's display name for `contact_search`: RFC 2047
 * encoded-words to text, then the invisible/bidi-override strip, then trim.
 *
 * Returns "" for a missing or non-string name, which is what the caller treats
 * as "this message did not name this address" — it falls back to the address's
 * local part only once, at the end of the aggregation.
 */
export function contactDisplayName(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw === "") return "";
  return neutralizeText(decodeEncodedWords(raw)).trim();
}
