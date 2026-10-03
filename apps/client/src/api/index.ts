/* The only place that decides which backend the app talks to.
 * Everything else imports `getMailApi()` / `getAssistantTransport()`. */

import type { AssistantTransport } from "./assistant-api";
import type { MailApi } from "./mail-api";
import { createMockAssistantTransport } from "./mock/assistant";
import { getMockMailApi } from "./mock";

export type { MailApi } from "./mail-api";
export { DEFAULT_PAGE_SIZE } from "./mail-api";
export type * from "./assistant-api";
export { toolIcon, toolTag } from "./assistant-api";
export * from "./types";

/** True while the app runs on the in-memory backend. */
export const IS_MOCK_BACKEND = true;

let mailApi: MailApi | null = null;
let transport: AssistantTransport | null = null;

export function getMailApi(): MailApi {
  // Real backend: `mailApi = new HttpMailApi({ baseUrl, getToken })`.
  if (!mailApi) mailApi = getMockMailApi();
  return mailApi;
}

export function getAssistantTransport(): AssistantTransport {
  if (!transport) transport = createMockAssistantTransport();
  return transport;
}

/** Tests and the Scenes menu can swap implementations. */
export function setMailApi(api: MailApi | null): void {
  mailApi = api;
}
export function setAssistantTransport(t: AssistantTransport | null): void {
  transport = t;
}
