#!/usr/bin/env node
// Writes public/llms.txt from src/lib/llms/llms-txt.mjs.
//
//   npm run gen:llms
//
// public/llms.txt is a generated file: edit the module, then run this. The
// test:llms-txt suite fails while the committed file and the module disagree,
// so a new client page or a new tool count cannot ship without it.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLlmsTxt } from '../src/lib/llms/llms-txt.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(path.join(webRoot, 'public/llms.txt'), buildLlmsTxt());
console.log('wrote public/llms.txt');
