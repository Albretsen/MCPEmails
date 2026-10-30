#!/usr/bin/env node
// Builds public/legal/mcpemails-dpa-<version>.pdf from the same text the /dpa
// page renders (app/[locale]/dpa/content.mjs), with headless Chrome.
//
//   node scripts/build-dpa-pdf.mjs            (from apps/web)
//   CHROME=/path/to/chrome node scripts/build-dpa-pdf.mjs
//
// A new DPA version gets a new file name; never overwrite a published version.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DPA_DOCUMENT, DPA_PDF_PATH, fillDpaText } from '../app/[locale]/dpa/content.mjs';
import { LEGAL_ENTITY_NAME, LEGAL_ORG_NUMBER, LEGAL_POSTAL_ADDRESS } from '../src/lib/email/legal.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(webRoot, 'public', DPA_PDF_PATH);
const values = { entity: LEGAL_ENTITY_NAME, orgNumber: LEGAL_ORG_NUMBER, address: LEGAL_POSTAL_ADDRESS };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (s) => esc(fillDpaText(s, values));

function block(b) {
  if (b.p) return `<p>${text(b.p)}</p>`;
  if (b.h3) return `<h3>${esc(b.h3)}</h3>`;
  if (b.ol) {
    return `<ol>${b.ol
      .map((i) => `<li>${i.label ? `<strong>${esc(i.label)}</strong> ` : ''}${text(i.text)}</li>`)
      .join('')}</ol>`;
  }
  if (b.table) {
    const head = b.table.head.map((h) => `<th>${esc(h)}</th>`).join('');
    const rows = b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${text(c) || '&nbsp;'}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  }
  return '';
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(DPA_DOCUMENT.title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; font-size: 10pt; line-height: 1.45; color: #111; }
  h1 { font-size: 18pt; margin: 0 0 4pt; }
  .version { color: #555; margin: 0 0 16pt; }
  h2 { font-size: 12.5pt; margin: 18pt 0 6pt; break-after: avoid; }
  h3 { font-size: 11pt; margin: 12pt 0 4pt; break-after: avoid; }
  p { margin: 0 0 6pt; }
  ol { margin: 0 0 6pt; padding-left: 16pt; }
  li { margin: 0 0 4pt; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0 8pt; font-size: 9pt; }
  th, td { border: 0.5pt solid #999; padding: 4pt 6pt; text-align: left; vertical-align: top; }
  th { background: #eee; }
  tr { break-inside: avoid; }
  #signatures td { height: 18pt; }
</style></head><body>
<h1>${esc(DPA_DOCUMENT.title)}</h1>
<p class="version">${esc(DPA_DOCUMENT.versionLine)} https://mcpemails.com/dpa</p>
${DPA_DOCUMENT.sections.map((s) => `<section id="${s.id}"><h2>${esc(s.h)}</h2>${s.blocks.map(block).join('')}</section>`).join('\n')}
</body></html>`;

const chrome =
  process.env.CHROME ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chrome) throw new Error('No Chrome found; set CHROME=/path/to/chrome');

const dir = mkdtempSync(join(tmpdir(), 'dpa-'));
const src = join(dir, 'dpa.html');
writeFileSync(src, html);
mkdirSync(dirname(out), { recursive: true });
execFileSync(chrome, [
  '--headless',
  '--disable-gpu',
  '--no-pdf-header-footer',
  `--print-to-pdf=${out}`,
  pathToFileURL(src).href,
]);
console.log(`Wrote ${out}`);
