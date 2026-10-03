import type { PlatformAdapter } from "./types";
import { createWebPlatform } from "./web";

export type * from "./types";
export { NOTIFICATION_ACTION } from "./types";
export { VAPID_PUBLIC_KEY } from "./web";

let platform: PlatformAdapter | null = null;

/** The adapter for the host this bundle runs in. Electron will install its own
 *  with `setPlatform()` from its preload before the app boots. */
export function getPlatform(): PlatformAdapter {
  if (!platform) platform = createWebPlatform();
  return platform;
}

export function setPlatform(p: PlatformAdapter | null): void {
  platform = p;
}
