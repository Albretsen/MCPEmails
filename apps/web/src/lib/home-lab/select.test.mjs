// Homepage Lab must never reach production: no variant, no picker, no bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pickHomeLabVariant, homeLabRewritePath, HOME_LAB_IDS } from './select.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('production never picks a variant, whatever the URL or cookie says', () => {
  for (const id of HOME_LAB_IDS) {
    assert.equal(pickHomeLabVariant({ appEnv: 'production', locale: 'en', query: id, cookie: id }), null);
    assert.equal(pickHomeLabVariant({ appEnv: 'development', locale: 'en', query: id, cookie: id }), null);
  }
});

test('staging picks a variant only for English', () => {
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'nb', query: 'v03' }), null);
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'de', cookie: 'v03' }), null);
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'en', query: 'v03' }), 'v03');
});

test('the query wins over the cookie; unknown ids fall back to the current page', () => {
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'en', query: 'v07', cookie: 'v02' }), 'v07');
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'en', cookie: 'v02' }), 'v02');
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'en', query: ['V05'] }), 'v05');
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'en', query: '../etc', cookie: 'x' }), 'v00');
  assert.equal(pickHomeLabVariant({ appEnv: 'staging', locale: 'en' }), 'v00');
});

test('the proxy rewrites only the bare English home path, only on staging, never for v00', () => {
  for (const id of HOME_LAB_IDS) {
    assert.equal(homeLabRewritePath({ appEnv: 'production', pathname: '/', query: id, cookie: id }), null);
  }
  assert.equal(homeLabRewritePath({ appEnv: 'staging', pathname: '/', query: 'v03' }), '/home-lab/v03');
  assert.equal(homeLabRewritePath({ appEnv: 'staging', pathname: '/', cookie: 'v09' }), '/home-lab/v09');
  assert.equal(homeLabRewritePath({ appEnv: 'staging', pathname: '/', query: 'v00', cookie: 'v09' }), null);
  assert.equal(homeLabRewritePath({ appEnv: 'staging', pathname: '/' }), null);
  assert.equal(homeLabRewritePath({ appEnv: 'staging', pathname: '/pricing', query: 'v03' }), null);
  assert.equal(homeLabRewritePath({ appEnv: 'staging', pathname: '/nb', query: 'v03' }), null);
});

const read = (rel) => readFileSync(path.join(webRoot, rel), 'utf8');
const IDS = HOME_LAB_IDS.filter((id) => id !== 'v00');

test('production builds alias every lab import to a stub', () => {
  const config = read('next.config.js');
  assert.match(config, /'home-lab-entry':\s*process\.env\.NEXT_PUBLIC_APP_ENV === 'staging'\s*\?\s*'\.\/components\/home-lab-shell\/HomeLab\.tsx'\s*:\s*'\.\/components\/home-lab-shell\/off\.ts'/);
  assert.match(config, /`home-lab-\$\{id\}`,\s*process\.env\.NEXT_PUBLIC_APP_ENV === 'staging'\s*\?\s*`\.\/components\/home-lab\/\$\{id\}\/Home\.jsx`\s*:\s*'\.\/components\/home-lab-shell\/off-variant\.tsx'/);
  for (const id of IDS) assert.match(config, new RegExp(`'${id}'`), `${id} has an alias`);
  for (const stub of ['components/home-lab-shell/off.ts', 'components/home-lab-shell/off-variant.tsx']) {
    assert.doesNotMatch(read(stub), /import\(|from '\.|home-lab\/v/, `${stub} imports no lab code`);
  }
});

test('lab code is reached only through the aliases, behind the staging guards', () => {
  // The home page never imports the lab; its shared renderer imports only the
  // aliased entry (a stub on production builds) and calls it behind the guards.
  assert.doesNotMatch(read('app/[locale]/page.tsx'), /home-lab/);
  const render = read('app/[locale]/home-render.tsx');
  const labImports = render.match(/^import[^\n]*home-lab[^\n]*$/gm) || [];
  assert.deepEqual(labImports, ["import { renderHomeLab } from 'home-lab-entry';"]);
  const guard = render.indexOf("process.env.NEXT_PUBLIC_APP_ENV === 'staging' && isStaging() && locale === 'en'");
  assert.ok(guard > 0 && render.indexOf('await renderHomeLab(') > guard, 'the picker renders only inside the guard');
  // Each variant route imports only its own alias and 404s outside English staging.
  for (const id of IDS) {
    const route = read(`app/[locale]/home-lab/${id}/page.tsx`);
    assert.match(route, new RegExp(`^import Variant from 'home-lab-${id}';$`, 'm'));
    assert.doesNotMatch(route, /components\/home-lab/);
  }
  // The picker shell lives outside the variants' parent folder and imports no
  // variant folder: sharing that folder put every variant's CSS on every page.
  for (const file of ['HomeLab.tsx', 'Picker.jsx', 'registry.mjs']) {
    assert.doesNotMatch(read(`components/home-lab-shell/${file}`), /from '\.\.\/home-lab|\/v\d\d\//, file);
  }
  for (const id of IDS) {
    const route = read(`app/[locale]/home-lab/${id}/page.tsx`);
    assert.match(route, /process\.env\.NEXT_PUBLIC_APP_ENV !== 'staging' \|\| !isStaging\(\) \|\| locale !== 'en'\) notFound\(\)/);
  }
  // The proxy rewrite is behind the inlined staging guard.
  const proxy = read('proxy.ts');
  assert.ok(proxy.indexOf("process.env.NEXT_PUBLIC_APP_ENV === 'staging'") < proxy.indexOf('homeLabRewritePath({'));
  // Nothing else in the app imports the lab.
  for (const file of ['app/layout.js', 'components/marketing/HomeClient.jsx', 'components/marketing/Sections.jsx']) {
    assert.doesNotMatch(read(file), /home-lab/, file);
  }
});

test('the picker registry matches every variant label (run scripts/home-lab/sync_registry.mjs)', async () => {
  const { HOME_LAB_VARIANTS } = await import('../../../components/home-lab-shell/registry.mjs');
  assert.deepEqual(HOME_LAB_VARIANTS.map((v) => v.id), HOME_LAB_IDS);
  for (const id of IDS) {
    const { meta } = await import(`../../../components/home-lab/${id}/meta.mjs`);
    const entry = HOME_LAB_VARIANTS.find((v) => v.id === id);
    assert.deepEqual(entry, { id: meta.id, name: meta.name, concept: meta.concept }, id);
  }
});
