/* Pure helpers of the scripted assistant: intent routing, canned edits and the
 * sentence shown for a tool call. Ported from the design prototype (`route`,
 * `editText`, `humanize`). No I/O, so they are unit-testable on their own. */

import type { ToolCallState, ToolName } from "../../assistant-api";
import type { AssistantHints } from "../seed";

export type ScenarioKind =
  | "firstrun"
  | "needs"
  | "receipts"
  | "newsletters"
  | "draft"
  | "shorter"
  | "warmer"
  | "send"
  | "send_background"
  | "summary"
  | "about"
  | "sender"
  | "archiveOne"
  | "generic";

/** Scenarios that are about ONE email (they get a target). */
export const EMAIL_KINDS: readonly ScenarioKind[] = [
  "draft",
  "summary",
  "shorter",
  "warmer",
  "send",
  "send_background",
  "about",
  "archiveOne",
  "sender",
];

const KINDS: readonly string[] = [
  "firstrun",
  "needs",
  "receipts",
  "newsletters",
  "draft",
  "shorter",
  "warmer",
  "send",
  "send_background",
  "summary",
  "about",
  "sender",
  "archiveOne",
  "generic",
];

export function isScenarioKind(v: string | undefined): v is ScenarioKind {
  return !!v && KINDS.includes(v);
}

/** Free text to a scenario. Order matters: it is the prototype's. */
export function route(text: string): ScenarioKind {
  const s = (text || "").toLowerCase();
  if (/short|concise|trim/.test(s)) return "shorter";
  if (/warm|friendl|nicer/.test(s)) return "warmer";
  if (/newsletter/.test(s)) return "newsletters";
  if (/receipt|invoice|\bfile\b/.test(s)) return "receipts";
  if (/\bsend\b/.test(s)) return "send";
  if (/need|waiting|unanswered|follow/.test(s)) return "needs";
  if (/draft|reply|respond|write/.test(s)) return "draft";
  if (/summar|tl;?dr/.test(s)) return "summary";
  return "generic";
}

/** Routing once it is known whether exactly one email is attached. */
export function routeWithContext(text: string, intent: string | undefined, single: boolean): ScenarioKind {
  if (isScenarioKind(intent)) return intent;
  const s = (text || "").toLowerCase();
  let kind = route(text);
  if (single) {
    if (kind === "generic" && /\barchive\b/.test(s)) return "archiveOne";
    if (kind === "generic" && /earlier from|other emails? from|more from/.test(s)) return "sender";
    // "What do they need from me?" typed while an email is attached is about
    // that email, not a scan of the inbox.
    if (kind === "needs" && !/inbox|all my|emails|everything/.test(s)) kind = "about";
    if (kind === "generic") kind = "about";
  }
  return kind;
}

/** The canned shorter / warmer version of a draft body. */
export function editText(body: string, kind: "shorter" | "warmer", hints?: AssistantHints): string {
  if (hints && hints[kind] && body === hints.reply) return hints[kind] as string;
  const ps = body.split("\n\n");
  if (kind === "shorter") {
    if (ps.length < 3) return body;
    const mid = ps
      .slice(1, -1)
      .map((p) => p.split(/(?<=\.)\s/)[0])
      .join(" ");
    return [ps[0], mid, ps[ps.length - 1]].join("\n\n");
  }
  const out = [...ps];
  if (out.length > 1) out[1] = `Thanks so much for this. ${out[1]}`;
  const last = out.length - 1;
  out[last] = (out[last] ?? "").replace(/^(Best|Thanks|Cheers),/, "Really appreciate it,");
  return out.join("\n\n");
}

/** The sentence shown in the transcript for a call in a given state. */
export function humanize(tool: ToolName, label: string, state: ToolCallState, action?: string): string {
  const run = state === "running" || state === "held";
  switch (tool) {
    case "email_read":
      return (run ? "Reading " : "Read ") + label;
    case "email_organize":
    case "email_search_and_move":
      return (run ? "Moving " : "Moved ") + label;
    case "email_search":
      return run ? "Searching your mail" : "Searched your mail";
    case "draft":
      return action === "edit"
        ? run
          ? "Editing the draft"
          : "Edited the draft"
        : run
          ? "Drafting a reply"
          : "Drafted a reply";
    case "email_compose":
      return state === "waiting"
        ? `Waiting for your approval to send ${label}`
        : state === "done"
          ? `Sent ${label}`
          : "Not sent";
    default:
      return label;
  }
}

const STOP_WORDS = ["about", "from", "with", "what", "emails", "email", "find", "show", "there", "have", "this", "that", "any", "the"];

/** Search words of a free-text request (generic fallback). */
export function searchWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9@.$]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.includes(w));
}
