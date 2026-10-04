/* The only place that decides which backend the app talks to.
 * Everything else imports `getMailApi()` / `getAssistantTransport()`. */

import { config } from "../config";
import type { AssistantTransport } from "./assistant-api";
import type { MailApi } from "./mail-api";
import { createMockAssistantTransport } from "./mock/assistant";
import { getMockMailApi } from "./mock";

export type { MailApi } from "./mail-api";
export { DEFAULT_PAGE_SIZE } from "./mail-api";
export type * from "./assistant-api";
export { toolIcon, toolTag } from "./assistant-api";
export * from "./types";

export { ApiError, describeError, isAbortError, isApiError } from "./http/client";
export { attachmentsTooLargeMessage, newIdempotencyKey } from "./http/http-mail-api";

/** True while the app runs on the in-memory backend (see config.ts). */
export const IS_MOCK_BACKEND: boolean = config.useMock;

let mailApi: MailApi | null = null;
let transport: AssistantTransport | null = null;

export function getMailApi(): MailApi {
  if (!mailApi) {
    // HTTP mode: app/backend.ts installs the HttpMailApi before the first render.
    if (!IS_MOCK_BACKEND) throw new Error("The HTTP backend is not installed yet.");
    mailApi = getMockMailApi();
  }
  return mailApi;
}

export function getAssistantTransport(): AssistantTransport {
  if (!transport) {
    if (!IS_MOCK_BACKEND) throw new Error("The HTTP backend is not installed yet.");
    transport = createMockAssistantTransport();
  }
  return transport;
}

/** Tests and the Scenes menu can swap implementations. */
export function setMailApi(api: MailApi | null): void {
  mailApi = api;
}
export function setAssistantTransport(t: AssistantTransport | null): void {
  transport = t;
}
