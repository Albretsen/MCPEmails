// ---------------------------------------------------------------------------
// `per_operation_tools: true`, telling the draft card which names its host lists.
//
// A host may only let the card call tools from its own listing, and ChatGPT
// answers any other name from its own backend without reaching this server
// (404 "MCP Resource not found"). The card used to send and delete with
// `draft{action}`, which no OpenAI key is listed, so Send and Delete draft always
// failed there. See apps/mcp-app/src/draft-tools.ts.
//
// The name the model just called is the proof: a host can only have called it
// because its listing has it. No lookup, so no read is added to any call, and it
// holds for a ChatGPT connection still on a pre-2026-10-13 listing, whose
// `draft` calls are not stamped and whose card goes on calling `draft`.
// `draft_read` and `draft_editor_save` are on both surfaces, so they prove
// nothing and are not stamped.
//
// Same channel as `diagnostics` (card-diagnostics.ts): `structuredContent` only,
// `content` stays byte for byte. Not result `_meta`, because a host may drop it
// (ChatGPT returned `_meta: null` on a card read, seen live 2026-11-02).
// Only ever `true`, so a consolidated result is unchanged.
// ---------------------------------------------------------------------------

import { cardEnvelopeIn } from "./card-diagnostics.ts";
import { PER_OPERATION_CARD_TOOL_NAMES } from "./mcp-app-resources.ts";

export const PER_OPERATION_TOOLS_FIELD = "per_operation_tools";

/** Stamp a draft result the host got by calling `calledName`, when that proves it. */
export function stampToolSurface(structured: unknown, calledName: string): void {
  if (!PER_OPERATION_CARD_TOOL_NAMES.drafts.includes(calledName)) return;
  const envelope = cardEnvelopeIn(structured);
  if (envelope) envelope[PER_OPERATION_TOOLS_FIELD] = true;
}
