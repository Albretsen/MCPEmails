#!/usr/bin/env node
// Prints the HTML size of every route in routes.mjs, raw and gzipped, from the
// current production build. Not a test: a measuring tool for before/after
// comparisons of what a page ships.
//   node scripts/built-output/measure-sizes.mjs > sizes.json
import { buildUnavailableReason, startServer, fetchRoute } from './harness.mjs';
import { ROUTES } from './routes.mjs';

const unavailable = buildUnavailableReason();
if (unavailable) {
  console.error(unavailable);
  process.exit(1);
}
const server = await startServer();
const sizes = {};
try {
  for (const { route, status } of ROUTES) {
    if (status >= 300 && status < 400) continue;
    const response = await fetchRoute(server.origin, route);
    sizes[route] = { status: response.status, raw: response.rawBytes, gzip: response.gzipBytes };
  }
} finally {
  await server.stop();
}
console.log(JSON.stringify(sizes, null, 1));
