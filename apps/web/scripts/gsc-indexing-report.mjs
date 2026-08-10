#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted && char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizedHeader(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function pageCount(value) {
  const count = Number.parseInt(String(value ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(count) ? count : 0;
}

export function summarizeIndexingCsv(csv) {
  const [headers = [], ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
  const keys = headers.map(normalizedHeader);
  const reasonIndex = keys.findIndex((key) => ['reason', 'why_pages_arent_indexed', 'status'].includes(key));
  const pagesIndex = keys.findIndex((key) => ['pages', 'affected_pages', 'urls'].includes(key));
  const sourceIndex = keys.findIndex((key) => key === 'source');
  const validationIndex = keys.findIndex((key) => ['validation', 'validation_status'].includes(key));
  if (reasonIndex < 0 || pagesIndex < 0) {
    throw new Error(`Expected GSC columns for Reason and Pages; received: ${headers.join(', ')}`);
  }
  const reasons = rows.map((row) => ({
    reason: row[reasonIndex]?.trim() || 'Unknown',
    pages: pageCount(row[pagesIndex]),
    source: sourceIndex >= 0 ? row[sourceIndex]?.trim() || null : null,
    validation: validationIndex >= 0 ? row[validationIndex]?.trim() || null : null,
  })).sort((a, b) => b.pages - a.pages || a.reason.localeCompare(b.reason));
  return { totalExcludedPages: reasons.reduce((sum, item) => sum + item.pages, 0), reasons };
}

export function toMarkdown(report) {
  const lines = [
    '# Google Search Console page-indexing reasons',
    '',
    `Total affected pages across exported reason buckets: ${report.totalExcludedPages}`,
    '',
    '| Reason | Pages | Source | Validation |',
    '|---|---:|---|---|',
  ];
  for (const item of report.reasons) {
    const values = [item.reason, item.pages, item.source ?? '—', item.validation ?? '—']
      .map((value) => String(value).replaceAll('|', '\\|'));
    lines.push(`| ${values.join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: node scripts/gsc-indexing-report.mjs <gsc-table.csv> [--json]');
  }
  const report = summarizeIndexingCsv(await readFile(inputPath, 'utf8'));
  process.stdout.write(process.argv.includes('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : toMarkdown(report));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
