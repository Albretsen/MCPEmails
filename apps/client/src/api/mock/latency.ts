/* Simulated network for the mock backend.
 *
 * URL overrides (read once at boot, changeable at runtime from the Scenes menu):
 *   ?latency=0      no delay at all
 *   ?latency=slow   2G-ish: reads 1.2-2.5 s, writes 1.5-3 s
 *   ?fail=write     every write rejects (exercises optimistic rollback)
 */

export type LatencyMode = "default" | "0" | "slow";

export interface LatencyConfig {
  mode: LatencyMode;
  read: [min: number, max: number];
  write: [min: number, max: number];
  failWrites: boolean;
}

const RANGES: Record<LatencyMode, Pick<LatencyConfig, "read" | "write">> = {
  default: { read: [120, 350], write: [200, 500] },
  "0": { read: [0, 0], write: [0, 0] },
  slow: { read: [1200, 2500], write: [1500, 3000] },
};

function fromUrl(): LatencyConfig {
  let mode: LatencyMode = "default";
  let failWrites = false;
  if (typeof location !== "undefined") {
    const p = new URLSearchParams(location.search);
    const l = p.get("latency");
    if (l === "0" || l === "slow") mode = l;
    failWrites = p.get("fail") === "write";
  }
  return { mode, ...RANGES[mode], failWrites };
}

let config: LatencyConfig = fromUrl();

export function getLatency(): LatencyConfig {
  return config;
}

export function setLatencyMode(mode: LatencyMode): void {
  config = { ...config, mode, ...RANGES[mode] };
}

export function setFailWrites(fail: boolean): void {
  config = { ...config, failWrites: fail };
}

/** Explicit ranges, for tests. */
export function setLatency(patch: Partial<LatencyConfig>): void {
  config = { ...config, ...patch };
}

export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const within = ([min, max]: [number, number]) => min + Math.random() * (max - min);

export function readDelay(signal?: AbortSignal): Promise<void> {
  return sleep(within(config.read), signal);
}

export class MockWriteError extends Error {
  constructor() {
    super("The mailbox did not accept the change. (Simulated failure: ?fail=write)");
    this.name = "MockWriteError";
  }
}

/** Waits, then rejects when writes are set to fail. */
export async function writeDelay(): Promise<void> {
  await sleep(within(config.write));
  if (config.failWrites) throw new MockWriteError();
}
