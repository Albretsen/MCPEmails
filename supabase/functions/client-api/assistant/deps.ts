/* Dependency types of the assistant module. The single source of truth is
 * `../assistant-deps.ts` (owned by client-api's core); this file only
 * re-exports it so every assistant module imports from one place. */

export type {
  AllowanceReservation,
  AssistantAllowance,
  AssistantDeps,
  AssistantUsage,
  HandleAssistantRun,
  Inbox,
  ToolRunner,
  ToolRunResult,
  ToolSchema,
} from "../assistant-deps.ts";
