/**
 * The running build's identity, for the kiosk's deploy check.
 *
 * Its own module rather than an export from the route handler that serves it:
 * a file under `app/` is a route, and importing a helper out of one into a
 * page makes the page's dependencies depend on a route's module graph for no
 * reason. Both sides import this instead.
 */

/**
 * `VERCEL_DEPLOYMENT_ID` changes on every deploy, which is precisely the
 * signal wanted. The commit sha is a fallback for a platform that sets one and
 * not the other, and 'dev' keeps local development from reloading itself on
 * every save, since neither variable exists there.
 */
export function currentDeployment(): string {
  return process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev';
}
