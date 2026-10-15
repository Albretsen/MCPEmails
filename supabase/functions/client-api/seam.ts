// ---------------------------------------------------------------------------
// The seam: what client-api uses from the MCP server module, as one interface.
//
// Everything client-api takes from `../mcp-server/index.ts` is named here, so
// the dependency is reviewable in one place and the router can be driven in
// tests with a stand-in. `loadMcpSeam` is the ONLY place that module is
// imported, and it does so only after guaranteeing its `Deno.serve` cannot run.
// ---------------------------------------------------------------------------

import type { ImapMessageSummary } from "../mcp-server/imap-client.ts";
import type { ApiKeyRow, ExecutorOutcome, InboxRow } from "../mcp-server/index.ts";

export type { ApiKeyRow, ExecutorOutcome, InboxRow };

/** The claim `claimOutboundIdempotency` returns, as far as client-api reads it. */
export type IdempotencyClaim =
  | { kind: "proceed"; keyDigest: string; requestDigest: string; key: string }
  | { kind: "replay"; key: string; status: string; approvalId?: string; result?: Record<string, unknown> | null }
  | { kind: "processing"; key: string }
  | { kind: "conflict"; key: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable" };

export interface ToolDefinitionLike {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ConsolidatedActionLike {
  legacy: string;
  scope: string;
  renames?: Record<string, string>;
}

export interface ImapStatusClient {
  mailboxChangeState(mailbox: string): Promise<{
    messages: number;
    unseen: number;
    uidNext: number;
    uidValidity: number;
    highestModSeq: string | null;
  }>;
  /** Messages in the mailbox as of the last SELECT, or null. */
  selectedMessageCount(): number | null;
  /** `LIST "" "*"`: every mailbox with its attributes (SPECIAL-USE included). */
  listMailboxes(): Promise<Array<{ name: string; delimiter: string; flags: string[] }>>;
  /** `uid:flags;...` for a sequence range of the selected mailbox, or null. */
  flagsBySequence(first: number, last: number): Promise<string | null>;
  /** `UID SEARCH <criteria>` in the selected mailbox (the `thread` op). */
  uidSearch(criteria: string): Promise<number[]>;
  /** The summary FETCH a listing issues, for these UIDs (the `thread` op). */
  fetchSummaries(
    uids: number[],
    options?: { includePreview?: boolean; gmailLabels?: boolean },
  ): Promise<ImapMessageSummary[]>;
  /** Did the server advertise this capability when the connection authenticated. */
  hasCapability(name: string): boolean;
  /** `UID FETCH <uids> (X-GM-THRID X-GM-MSGID)` (Gmail over IMAP; the `thread` op). */
  fetchGmailIds(uids: number[]): Promise<Array<{ uid: number; threadId: string; messageId: string }>>;
  /** True while a command is in flight (a search that outlived its budget). */
  readonly busy?: boolean;
}

export interface ImapSessionLike {
  client(): Promise<ImapStatusClient>;
  /** SELECT (skipped when already selected on this session), then the client. */
  select(mailbox: string): Promise<ImapStatusClient>;
  close(): Promise<void>;
}

export interface McpSeam {
  dispatchExecutor(dispatchName: string, rawArgs: unknown, apiKey: ApiKeyRow): Promise<ExecutorOutcome | null>;
  claimOutboundIdempotency(operation: string, rawArgs: unknown, apiKey: ApiKeyRow): Promise<IdempotencyClaim | null>;
  completeOutboundIdempotency(
    claim: IdempotencyClaim | null,
    operation: string,
    apiKeyId: string,
    logStatus: "success" | "error",
    logErrorCode: string | null,
    approvalId?: string,
    partial?: boolean,
    resultSnapshot?: Record<string, unknown> | null,
  ): Promise<void>;
  // deno-lint-ignore no-explicit-any
  isPartialToolResult(response: any): boolean;
  // deno-lint-ignore no-explicit-any
  pendingApprovalIdFromToolResult(response: any): string | undefined;
  // deno-lint-ignore no-explicit-any
  replaySnapshotFromToolResult(response: any): Record<string, unknown> | null;
  resolveInbox(inboxId: string, apiKey: ApiKeyRow): Promise<InboxRow | null>;
  resolveFolderId(
    inbox: InboxRow,
    nameOrId: string,
    // deno-lint-ignore no-explicit-any
    opts: { strict?: boolean; forRead?: boolean; session?: any },
  ): Promise<string>;
  imapSessionFor(inbox: InboxRow): ImapSessionLike | null;
  outlookFolderPathSegment(folder: string): string;
  withFreshGmailToken(inbox: InboxRow): Promise<string>;
  withFreshOutlookToken(inbox: InboxRow): Promise<string>;
  // deno-lint-ignore no-explicit-any
  serviceRoleClient: any;
  /** The `inboxes` projection `resolveInbox` selects (absent on a test stand-in). */
  INBOX_SELECT_COLUMNS?: string;
  TOOL_REGISTRY: ToolDefinitionLike[];
  CONSOLIDATED_SPECS: Record<string, { actions: Record<string, ConsolidatedActionLike> }>;
  validateInputSchema(schema: unknown, value: unknown): Array<{ path?: string; message?: string }>;
}

export class ListenGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListenGuardError";
  }
}

const NO_LISTEN = "MCP_SERVER_NO_LISTEN";

/**
 * Where the no-listen marker lives. Supabase's edge runtime refuses
 * `Deno.env.set` (NotSupported), and the variable must not be a project secret
 * because secrets are shared with the real mcp-server function, which would
 * then stop listening. So the marker is a property on this isolate's
 * `globalThis`, which mcp-server/index.ts checks next to the env var. An env
 * var set by a test runner still counts on read.
 */
const isolateFlags = {
  get(name: string): string | undefined {
    const flag = (globalThis as Record<string, unknown>)[name];
    if (flag === "1") return "1";
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  },
  set(name: string, value: string): void {
    (globalThis as Record<string, unknown>)[name] = value;
  },
};

/**
 * Import the MCP server module with its HTTP listener guaranteed off.
 *
 * mcp-server/index.ts ends with
 *     if (Deno.env.get("MCP_SERVER_NO_LISTEN") !== "1" && globalThis.MCP_SERVER_NO_LISTEN !== "1")
 *       Deno.serve(handleRequest);
 * evaluated once, at module load. If that ran here, this isolate would serve
 * the MCP protocol (API-key auth, the action cap, `activity_log`) on
 * client-api's URL. So: set the variable, read it back, and only then import.
 * If it cannot be set or does not read back as "1", throw BEFORE importing;
 * the caller answers every request with a 500 and never touches the module.
 */
export async function loadMcpSeam(
  env: { get(name: string): string | undefined; set(name: string, value: string): void } = isolateFlags,
  importer: () => Promise<unknown> = () => import("../mcp-server/index.ts"),
): Promise<McpSeam> {
  try {
    env.set(NO_LISTEN, "1");
  } catch (error) {
    throw new ListenGuardError(
      `cannot set ${NO_LISTEN}: ${error instanceof Error ? error.name : "error"}`,
    );
  }
  let readBack: string | undefined;
  try {
    readBack = env.get(NO_LISTEN);
  } catch (error) {
    throw new ListenGuardError(
      `cannot read ${NO_LISTEN}: ${error instanceof Error ? error.name : "error"}`,
    );
  }
  if (readBack !== "1") throw new ListenGuardError(`${NO_LISTEN} did not read back as "1"`);
  const mod = await importer() as Record<string, unknown>;
  for (const name of ["dispatchExecutor", "serviceRoleClient", "resolveInbox", "TOOL_REGISTRY"]) {
    if (mod[name] === undefined) throw new ListenGuardError(`mcp-server module is missing ${name}`);
  }
  return mod as unknown as McpSeam;
}
