/**
 * Remotion CLI config, used by `npm run studio`. The programmatic render in
 * scripts/render.mjs sets the same values explicitly rather than reading this
 * file, so if you change one, change both.
 */
import { Config } from '@remotion/cli/config';

// Every deliverable is H.264 in yuv420p. Safari refuses anything else, and the
// marketing site has to play in Safari.
Config.setVideoImageFormat('jpeg');
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');

// captures/ and assets/vo/ are exposed to staticFile() through symlinks inside
// public/. scripts/lib/public-dir.mjs creates them; doctor checks them.
Config.setPublicDir('public');

// Screen recordings are large. Overlapping too many renderers on a laptop
// starves the video decoder and yields dropped frames rather than a faster
// render.
Config.setConcurrency(4);
