// Preloaded into the `next start` the built-output suites spawn (see
// harness.mjs). It makes every lookup of the placeholder Supabase host fail at
// once, in process, instead of going to the network.
//
// The placeholder build points Supabase at https://placeholder.supabase.co,
// which does not exist. The home page reads an experiment from it on every
// request and falls back to the control variant when the read fails, which is
// the behaviour the snapshots record. Left to the real resolver, how long that
// failure takes is up to the machine's DNS: usually milliseconds, 7 seconds per
// request on one run here, and over 15 minutes for the suite on another. This
// makes it immediate and the same everywhere, and keeps the suite off the
// network. Nothing else is touched: any other hostname resolves normally.
import dns from 'node:dns';

const BLOCKED = 'placeholder.supabase.co';
const realLookup = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  if (hostname !== BLOCKED) return realLookup.call(this, hostname, options, callback);
  const done = typeof options === 'function' ? options : callback;
  const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
    code: 'ENOTFOUND',
    errno: -3008,
    syscall: 'getaddrinfo',
    hostname,
  });
  process.nextTick(done, error);
  return {};
};
