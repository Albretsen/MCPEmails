import type { MessageKey } from "../types";
import { MockMailApi } from "./mock-mail-api";
import type { AssistantHints, MockProfile } from "./seed";

export { MockMailApi } from "./mock-mail-api";
export type { MockMessage } from "./mock-mail-api";
export { MOCK_INBOXES, MOCK_PROFILES, MOCK_USER, SEED, THREADS, INCOMING, CUSTOM_FOLDERS } from "./seed";
export type { AssistantHints, MockBox, MockProfile, SeedEmail } from "./seed";
export { getLatency, setLatencyMode, setFailWrites, sleep, abortError } from "./latency";
export type { LatencyMode } from "./latency";

const PROFILE_KEY = "mc-mock-profile";

/** `?profile=first|pro` wins, then the last one picked in the Scenes menu. */
export function initialMockProfile(): MockProfile {
  try {
    const p = new URLSearchParams(location.search).get("profile");
    if (p === "first" || p === "pro") return p;
    const s = localStorage.getItem(PROFILE_KEY);
    if (s === "first" || s === "pro") return s;
  } catch {
    /* no location / storage (tests, private mode) */
  }
  return "pro";
}

export function rememberMockProfile(profile: MockProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, profile);
  } catch {
    /* ignore */
  }
}

let instance: MockMailApi | null = null;

/** The one mock backend of this page load. The mock assistant acts on the same
 *  instance, so its moves and drafts show up in the mail lists. */
export function getMockMailApi(): MockMailApi {
  if (!instance) instance = new MockMailApi(initialMockProfile());
  return instance;
}

/** Mock-only side table for the scripted assistant. Never part of a wire type. */
export function getMockHints(key: MessageKey): AssistantHints | undefined {
  return getMockMailApi().getHints(key);
}
