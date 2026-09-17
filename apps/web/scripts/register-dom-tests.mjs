// Bootstrap for `node --import`, for the suites that render real dashboard
// components. Registers the `@/*` alias hooks (same as register-ts-alias.mjs)
// plus the JSX transform and the two module substitutions in jsx-hooks.mjs.
//
// Order matters: the alias hooks must resolve `@/lib/...` before jsx-hooks can
// decide whether a resolved URL is a `.jsx` file, and `register` builds the
// chain last-registered-first, so jsx-hooks goes on afterwards.
import { register } from 'node:module';

register('./ts-alias-hooks.mjs', import.meta.url);
register('./jsx-hooks.mjs', import.meta.url);
