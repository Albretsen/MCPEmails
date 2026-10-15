/* The captures the web client's tests replay are what the engine emits NOW.
 * A failure here means the engine's output changed: regenerate (see
 * testing/fixtures.ts) and run the client's tests against the new bytes. */

import { capture, FIXTURE_DIR, SCENARIOS } from "./testing/fixtures.ts";

for (const scenario of SCENARIOS) {
  Deno.test(`fixture ${scenario.name}.sse is the engine's current output, byte for byte`, async () => {
    const recorded = await Deno.readTextFile(new URL(`${scenario.name}.sse`, FIXTURE_DIR));
    const now = await capture(scenario);
    if (recorded !== now) {
      throw new Error(
        `apps/client/src/api/http/fixtures/${scenario.name}.sse is stale. Regenerate with testing/fixtures.ts and re-run the client tests.`,
      );
    }
    const request = await Deno.readTextFile(new URL(`${scenario.name}.request.json`, FIXTURE_DIR));
    if (request !== JSON.stringify(scenario.body, null, 2) + "\n") throw new Error(`${scenario.name}.request.json is stale.`);
  });
}
