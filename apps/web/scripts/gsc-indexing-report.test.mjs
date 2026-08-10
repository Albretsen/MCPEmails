import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { summarizeIndexingCsv, toMarkdown } from './gsc-indexing-report.mjs';

test('summarizes a Search Console page-indexing CSV without network mutation', () => {
  const report = summarizeIndexingCsv(
    'Reason,Source,Validation,Pages\r\n"Crawled, currently not indexed",Google systems,Not Started,"21"\r\nDuplicate,Website,Passed,10\r\n',
  );
  assert.equal(report.totalExcludedPages, 31);
  assert.equal(report.reasons[0].reason, 'Crawled, currently not indexed');
  assert.match(toMarkdown(report), /\| Duplicate \| 10 \| Website \| Passed \|/);
});

test('fails clearly when the wrong GSC export table is supplied', () => {
  assert.throws(() => summarizeIndexingCsv('URL,Clicks\n/a,2\n'), /Reason and Pages/);
});

test('CLI dry-run reads an exported fixture and emits the reason report', () => {
  const script = fileURLToPath(new URL('./gsc-indexing-report.mjs', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/gsc-page-indexing.csv', import.meta.url));
  const result = spawnSync(process.execPath, [script, fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total affected pages[^\n]+31/);
  assert.match(result.stdout, /Crawled, currently not indexed/);
});
