# Usage-based pricing internal reports

Run the [reporting pack](internal-reports.sql) with the service/admin
reporting role after the shadow-meter migration has been applied. It provides
the three required operational reports without exposing email content,
recipients, tool arguments, API-key IDs, inbox IDs, customer email addresses,
or Stripe customer IDs.

## Cadence and ownership

Use one explicit UTC `report_end` timestamp for all four queries in a review.
Record that timestamp, the meter version, SQL revision, operator, query-output
hash, and a link to the reviewed export in the migration record.

| Report | When | Required decision/evidence |
| --- | --- | --- |
| Shadow distribution | Weekly during shadow, then at the 30-day close | Review Free, Agent, and Scale p50/p80/p95 against their proposed caps, along with success/failure rates and the billable tool mix. Amend the migration contract before enforcement if the distribution does not support a cap. |
| Eligibility candidates | Once, at the 30-day shadow close | Run only the approved candidate query and export the approved CSV schema. Review row count, aggregate actions, and the eligibility basis before inserting any grant. |
| Grant audit | Before and after every candidate import; weekly during enforcement | Confirm each active `comped_scale` entitlement covers all owned workspaces and inspect any update/delete audit event with a support ticket. |
| Anomalies | Daily while shadowing; before every rollout cohort; immediately after an incident | Every non-zero result needs a disposition. Disable enforcement first for metering or entitlement anomalies, preserve the ledger, then repair before re-enabling. |

## Interpretation

- The distribution report includes zero-action active workspaces so percentiles
  describe the population of a current plan, not only heavy users.
- `successful_vs_failed_calls` is based on the existing activity log and is a
  reliability signal, not a billable count. The ledger remains the source of
  truth for customer-visible billable actions.
- The five-minute reconciliation tolerance accommodates the independent
  append-only activity and usage writes. It is an anomaly detector, not a
  backfill mechanism. Investigate sampling discrepancies under the approved
  admin-only procedure in [phase-1-operations.md](phase-1-operations.md).
- The grant audit intentionally omits a grant reason. Support retrieves a
  single customer’s reason only through the approved audit path; broad reports
  must not become a customer-data export.

## Candidate and grant record retention

The candidate report is intentionally not duplicated in the pack. The only
approved candidate generator is
[phase-0-comped-grant-candidates.sql](phase-0-comped-grant-candidates.sql),
with its fixed [CSV schema](phase-0-comped-grant-candidates.schema.csv).
Store the original read-only export, reviewer fields, approval, and the
resulting entitlement-audit export together. Never regenerate an earlier
candidate list with a different end timestamp or query revision.
