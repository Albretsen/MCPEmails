// Bootstrap for `node --import`. Registers the `@/*` resolution hooks so a
// plain `node --test` run can load app source that uses the tsconfig alias.
import { register } from 'node:module';

register('./ts-alias-hooks.mjs', import.meta.url);
