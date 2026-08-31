/**
 * Remotion's staticFile() resolves against one directory. This tool has two
 * places that hold media, and the development guide fixes both paths:
 * captures/ for recordings and assets/vo/ for voiceover.
 *
 * Rather than move either (or point publicDir at the project root, which would
 * expose node_modules to the dev server), public/ holds a symlink to each. So
 * staticFile('captures/add-inbox.webm') and staticFile('vo/x.mp3') both work,
 * in the Studio and in a headless render, with the documented layout intact.
 *
 * public/ is generated, and gitignored. Every entry point that can reach a
 * render calls ensurePublicDir() first, so it is never a manual step.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { paths, ROOT } from './common.mjs';

const LINKS = [
  { name: 'captures', target: paths.captures },
  { name: 'vo', target: paths.vo },
];

export const PUBLIC_DIR = resolve(ROOT, 'public');

export function ensurePublicDir() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  const created = [];

  for (const { name, target } of LINKS) {
    // The link target has to exist or the static server 404s the whole
    // directory rather than the one missing file, which is a confusing way to
    // learn you have not captured anything yet.
    mkdirSync(target, { recursive: true });

    const link = resolve(PUBLIC_DIR, name);
    const wanted = relative(PUBLIC_DIR, target);

    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
      const stat = lstatSync(link);
      if (stat.isSymbolicLink() && readlinkSync(link) === wanted) continue;
      // A stale link, or a real directory someone dropped in by hand. Replace
      // it: this directory is entirely generated, so nothing here is precious.
      rmSync(link, { recursive: true, force: true });
    }

    symlinkSync(wanted, link, 'dir');
    created.push(name);
  }

  return { publicDir: PUBLIC_DIR, created };
}

/** The staticFile() path for a shot's recording. */
export const captureSrc = (shot) => `captures/${shot}.webm`;
