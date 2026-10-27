// ---------------------------------------------------------------------------
// MCP Apps — the automation card.
//
// The card mounts under `automation` and `automation_read` results (the
// consolidated surface only, see mcp-app-resources.ts#AUTOMATION_CARD_TOOL_NAMES)
// and shows one stored rule: the rule in one plain sentence, what it would
// match right now, and one switch. It never edits a rule; the model does that.
//
// ── The model's result is untouched ─────────────────────────────────────────
// Nothing here changes what `automation` / `automation_read` return. The card
// reads the plain result (the rule id from `automation.id`, or the preview's
// matches) and asks this module's one tool for everything else. So a host that
// shows no card, and the model in every host, see byte-identical results.
//
// ── `card_automation` assumes a hostile caller ──────────────────────────────
// `visibility: ["app"]` is a host hint with no security content (mcp-app-bulk.ts
// header, Phase 0 Q2), so treat every call as one a prompt-injected agent made:
//   * It can do nothing the model could not already do with `automation`
//     enable / disable / get / preview, because it IS those calls: every read
//     and write goes through `runAutomationTool` with the caller's own deps, so
//     workspace tenancy, the key's inbox allow-list, the stored action's scope
//     check and the rebind-to-caller rule all apply unchanged.
//   * It acts on the one rule it is named with, and takes nothing else that can
//     shape a write: `enabled` is a boolean, and unknown arguments are refused.
//   * Idempotent: asking for the state the rule is already in writes nothing
//     (an enable would otherwise move `next_run_at` and re-bind the rule).
//   * Not billable (absent from BILLABLE_TOOL_NAMES) and not an outbound
//     operation. A foreign and a nonexistent id get the same "not found".
//
// Named `card_automation`, not `automation_card`: index.ts routes every
// `automation_*` name to runAutomationTool by prefix (tool-surface.test.ts).
//
// Pure apart from the injected deps, so `mcp-app-automation.test.ts` drives it.
// ---------------------------------------------------------------------------

import { CARD_SCHEMA_VERSION } from "./mcp-app-approvals.ts";
import { neutralizeText } from "./text-safety.ts";
import { type AutomationDeps, runAutomationTool, type TriageToolResult } from "./triage-engine.ts";

export const AUTOMATION_CARD_TOOL = "card_automation";
export const AUTOMATION_CARD = "automation";

/** How many matches the card lists. The count covers the rest. */
export const AUTOMATION_CARD_SAMPLE = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ARGS = new Set(["automation_id", "enabled", "preview"]);

export const AUTOMATION_CARD_TOOL_DEFINITION = {
  name: AUTOMATION_CARD_TOOL,
  title: "Automation card",
  description:
    "Used by the automation card. Reads one automation with a dry run of what it " +
    "matches now, or turns it on or off. Pass automation_id, and enabled to switch it.",
  requiredScope: "manage:automations" as const,
  inputSchema: {
    type: "object",
    properties: {
      automation_id: { type: "string", format: "uuid", description: "The automation's UUID." },
      enabled: { type: "boolean", description: "Turn the automation on (true) or off (false)." },
      preview: {
        type: "boolean",
        description: "false skips the dry run. Ignored when enabled is given.",
      },
    },
    required: ["automation_id"],
    additionalProperties: false,
  },
  annotations: {
    title: "Automation card",
    readOnlyHint: false,
    // Turning a rule on lets it act on mail unattended.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const EVERY: Record<number, string> = {
  15: "every 15 minutes",
  30: "every 30 minutes",
  60: "every hour",
  1440: "every day",
};

function cadence(minutes: unknown): string {
  const m = typeof minutes === "number" && minutes > 0 ? Math.trunc(minutes) : 0;
  if (!m) return "";
  return EVERY[m] ?? (m % 60 === 0 ? `every ${m / 60} hours` : `every ${m} minutes`);
}

const str = (v: unknown) => (typeof v === "string" ? neutralizeText(v).trim().slice(0, 120) : "");
const quoted = (v: unknown) => `"${str(v)}"`;

/** "unread mail from news@x.com with "Sale" in the subject". */
export function describeFilter(filter: unknown): string {
  const f = (filter && typeof filter === "object" ? filter : {}) as Record<string, unknown>;
  const adj: string[] = [];
  if (f.unread === true) adj.push("unread");
  if (f.unread === false) adj.push("read");
  if (f.flagged === true) adj.push("flagged");
  if (f.flagged === false) adj.push("unflagged");
  const parts: string[] = [...adj, "mail"];
  if (str(f.from)) parts.push(`from ${str(f.from)}`);
  if (str(f.to)) parts.push(`to ${str(f.to)}`);
  if (str(f.cc)) parts.push(`copied to ${str(f.cc)}`);
  if (str(f.subject)) parts.push(`with ${quoted(f.subject)} in the subject`);
  if (str(f.body)) parts.push(`with ${quoted(f.body)} in the body`);
  if (str(f.text)) parts.push(`mentioning ${quoted(f.text)}`);
  if (f.has_attachment === true) parts.push("with attachments");
  if (f.has_attachment === false) parts.push("without attachments");
  if (str(f.since)) parts.push(`received since ${str(f.since).slice(0, 10)}`);
  if (str(f.before)) parts.push(`received before ${str(f.before).slice(0, 10)}`);
  return parts.join(" ");
}

/**
 * The rule in one plain sentence: "Move mail from news@x.com to Newsletters,
 * every hour." Built here rather than in the card, which has no bytes to spare.
 */
export function automationSentence(rule: Record<string, unknown>): string {
  const mail = describeFilter(rule.filter);
  const a = (rule.action && typeof rule.action === "object" ? rule.action : {}) as Record<
    string,
    unknown
  >;
  let what: string;
  switch (a.type) {
    case "move":
      what = `Move ${mail} to ${str(a.folder) || "a folder"}`;
      break;
    case "label":
      what = `Label ${mail} as ${quoted(a.label)}`;
      break;
    case "mark_read":
      what = `Mark ${mail} as read`;
      break;
    case "forward": {
      const to = (Array.isArray(a.to) ? a.to : []).map(str).filter(Boolean);
      what = `Forward ${mail} to ${to.join(", ") || "a recipient"}, each one held for approval`;
      break;
    }
    case "draft_reply":
      what = `Write a draft reply to ${mail}`;
      break;
    default:
      what = `Act on ${mail}`;
  }
  const every = cadence(rule.interval_minutes);
  return `${what}${every ? `, ${every}` : ""}.`;
}

/** Why an OFF rule is off, when it was not simply switched off. */
function noteFor(rule: Record<string, unknown>): string | null {
  if (rule.enabled === true) {
    return rule.paused_reason ? "Paused: this workspace reached its plan limit." : null;
  }
  const reason = str(rule.disabled_reason);
  if (!reason || reason === "Disabled by request.") return null;
  return `Turned off: ${reason}`;
}

interface CardMatch {
  from: string;
  subject: string;
}

function cardMatches(raw: unknown): CardMatch[] {
  return (Array.isArray(raw) ? raw : []).slice(0, AUTOMATION_CARD_SAMPLE).map((m) => ({
    from: str(m?.from),
    subject: str(m?.subject),
  }));
}

function cardError(text: string, code: string): TriageToolResult {
  return {
    result: { content: [{ type: "text", text }], isError: true },
    logStatus: "error",
    logErrorCode: code,
  };
}

/** Reads the `structuredContent` of a successful inner call, or null. */
function okPayload(r: TriageToolResult): Record<string, unknown> | null {
  return r.result.isError ? null : r.result.structuredContent ?? null;
}

/**
 * The one card tool. `{automation_id}` reads the rule plus a dry run;
 * `{automation_id, enabled}` switches it (and skips the dry run, the card
 * already has one); `preview: false` skips the dry run on a read.
 */
export async function runAutomationCard(
  rawArgs: unknown,
  deps: AutomationDeps,
): Promise<TriageToolResult> {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return cardError("card_automation: arguments must be an object.", "-32602");
  }
  const args = rawArgs as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARGS.has(key)) {
      return cardError(
        `card_automation: unknown argument '${neutralizeText(key).slice(0, 40)}'.`,
        "-32602",
      );
    }
  }
  const id = typeof args.automation_id === "string" ? args.automation_id.trim() : "";
  if (!UUID_RE.test(id)) {
    return cardError("card_automation: a valid automation_id (UUID) is required.", "-32602");
  }
  if (args.enabled !== undefined && typeof args.enabled !== "boolean") {
    return cardError("card_automation: enabled must be true or false.", "-32602");
  }

  const got = await runAutomationTool("get", { automation_id: id }, deps);
  let rule = okPayload(got)?.automation as Record<string, unknown> | undefined;
  if (!rule) return got;

  let switched = false;
  if (typeof args.enabled === "boolean" && rule.enabled !== args.enabled) {
    const flip = await runAutomationTool(args.enabled ? "enable" : "disable", {
      automation_id: id,
    }, deps);
    const next = okPayload(flip)?.automation as Record<string, unknown> | undefined;
    if (!next) return flip;
    rule = next;
    switched = true;
  }

  let preview: Record<string, unknown> | null = null;
  let previewFailed = false;
  if (args.enabled === undefined && args.preview !== false) {
    const dry = await runAutomationTool("preview", { automation_id: id }, deps);
    preview = okPayload(dry);
    previewFailed = preview === null;
  }

  let inbox: string | null = null;
  if (typeof rule.inbox_id === "string") {
    const resolved = await deps.resolveInbox({ inbox_id: rule.inbox_id });
    if (resolved.ok) inbox = str(resolved.inbox.email_address) || null;
  }

  const payload = {
    schema_version: CARD_SCHEMA_VERSION,
    card: AUTOMATION_CARD,
    state: "pending",
    automation: {
      id,
      name: str(rule.name),
      enabled: rule.enabled === true,
      sentence: automationSentence(rule),
      inbox,
      note: noteFor(rule),
      // Absent when no dry run was asked for, so the card keeps the one it has.
      ...(preview
        ? {
          matched: typeof preview.matched === "number" ? preview.matched : 0,
          capped: typeof preview.matched === "number" &&
            typeof preview.capped_at === "number" && preview.matched >= preview.capped_at,
          matches: cardMatches(preview.matches),
        }
        : {}),
      ...(previewFailed ? { preview_failed: true } : {}),
    },
  };
  const text = switched
    ? `Automation ${rule.enabled === true ? "enabled" : "disabled"} from the card.`
    : "Automation shown in the card.";
  return {
    result: { content: [{ type: "text", text }], structuredContent: payload, isError: false },
    logStatus: "success",
    logErrorCode: null,
  };
}
