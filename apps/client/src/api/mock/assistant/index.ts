/* The mock assistant: a scripted transport that reproduces the design
 * prototype's scenarios as an event stream (see engine.ts). */

import type { AssistantTransport } from "../../assistant-api";
import { ScriptedAssistantTransport } from "./engine";

export { ScriptedAssistantTransport, TIMING, getAssistantPace, setAssistantPace } from "./engine";
export type { ScriptedAssistantOptions } from "./engine";
export { EMAIL_KINDS, editText, humanize, isScenarioKind, route, routeWithContext, searchWords } from "./route";
export type { ScenarioKind } from "./route";

export function createMockAssistantTransport(): AssistantTransport {
  return new ScriptedAssistantTransport();
}
