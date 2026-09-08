// ---------------------------------------------------------------------------
// The `MCP-Protocol-Version` request header.
//
// Streamable HTTP clients send the version they negotiated at initialize on
// every later request. The transport spec says a server that receives an
// UNSUPPORTED value must answer HTTP 400, and that a missing header means the
// client predates the header and is assumed to speak 2025-03-26.
//
// This server used to ignore the header entirely, and the /api/mcp proxy did
// not even forward it, so no real client value has ever been observed here.
// The check is therefore deliberately conservative: EVERY published revision
// of the protocol counts as supported, whatever the initialize handshake
// echoed, because the server's behaviour is identical across them (see the
// SUPPORTED_PROTOCOL_VERSION note in index.ts). Only a value that names no
// revision at all is refused. The value is also logged by the caller so the
// distribution real clients send can be read back before anything tightens.
//
// Pure and dependency-free so it can be tested without booting the server.
// ---------------------------------------------------------------------------

/**
 * Every protocol revision published to date. A header naming any of these is
 * accepted. Extend this list when a new revision is published; never shrink
 * it without checking the client distribution in the logs first.
 */
export const KNOWN_PROTOCOL_VERSIONS: readonly string[] = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

/** What the spec says to assume when the header is absent. */
export const DEFAULT_PROTOCOL_VERSION_WHEN_ABSENT = "2025-03-26";

/** A revision string is a calendar date; anything else is malformed. */
const REVISION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export type ProtocolVersionHeaderReading =
  /** No header (or an empty one): assume DEFAULT_PROTOCOL_VERSION_WHEN_ABSENT. */
  | { kind: "absent"; assumed: string }
  /** A known revision. */
  | { kind: "supported"; version: string }
  /** Present, but not a revision this server knows. Answer HTTP 400. */
  | { kind: "unsupported"; received: string; wellFormed: boolean };

/**
 * Classify the raw header value. Whitespace around the value is ignored, as
 * HTTP permits; nothing else is normalised, because the revision strings are
 * exact tokens and a client that sends "2025-6-18" is not sending one.
 */
export function readProtocolVersionHeader(
  raw: string | null | undefined,
): ProtocolVersionHeaderReading {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    return { kind: "absent", assumed: DEFAULT_PROTOCOL_VERSION_WHEN_ABSENT };
  }
  if (KNOWN_PROTOCOL_VERSIONS.includes(value)) {
    return { kind: "supported", version: value };
  }
  return {
    kind: "unsupported",
    received: safeHeaderValueForLog(value),
    wellFormed: REVISION_SHAPE.test(value),
  };
}

/**
 * A bounded, printable rendering of a header value for the operator log and
 * the 400 body. Header values are caller-controlled text, so this keeps them
 * short and strips anything outside the printable ASCII range rather than
 * echoing arbitrary bytes into a log line.
 */
export function safeHeaderValueForLog(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > 40 ? `${printable.slice(0, 40)}…` : printable;
}
