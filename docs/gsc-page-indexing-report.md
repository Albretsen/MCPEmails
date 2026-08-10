# Page-indexing reason report

Google Search Console's Search Analytics API does not expose the bulk
"Why pages aren't indexed" table. Export that table from **Indexing → Pages**
as CSV, then produce a reproducible, read-only summary locally:

```sh
cd apps/web
node scripts/gsc-indexing-report.mjs /absolute/path/to/Table.csv
```

Use `--json` for machine-readable output. The command reads the exported CSV
and writes the report to standard output; it does not call or mutate Search
Console. Keep the source export outside the repository because URL-level GSC
exports can contain unpublished or otherwise sensitive paths.

Review the largest reasons first. Treat redirects, alternate canonicals, and
intentional `noindex` pages as expected until the affected URL samples prove
otherwise; a raw count of excluded pages is not itself a defect count.
