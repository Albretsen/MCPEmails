# Phase 1 operations: shadow meter

## Deployment order

1. Apply `20260803010000_create_action_usage_shadow_meter.sql`.
2. Deploy the MCP edge function. It writes one `action_usage` row only after a
   successful `tools/call` dispatch and never blocks a request.
3. Enable `USAGE_SHADOW_WOULD_BLOCK=true` only after the ledger is receiving
   rows. It emits aggregate plan/count/cap diagnostics and still never rejects
   a call.
4. Keep the shadow meter visible for 30 complete days before running the
   eligibility query from phase 0.

## Backfill policy

There is deliberately no action-ledger backfill from `activity_log`. Earlier
rows do not carry the meter-versioned, allow-list classification required for
an auditable customer meter. Shadow measurement starts at the MCP deployment
timestamp; preserve that timestamp in the launch record. `activity_log` stays
available for a sampled reconciliation only, not as the customer-meter source.

## Internal reporting pack

Run the read-only [internal reporting pack](internal-reports.md) with a
single explicit `report_end` timestamp after the shadow period. It covers the
required distribution (including plan usage and p50/p80/p95), successful vs
failed call rate, tool mix, approved eligibility candidates, protected-grant
audit, and meter/enforcement anomalies. It returns IDs and aggregate meter
data only—never email content, recipients, arguments, inbox IDs, API-key IDs,
or customer email addresses.

Compare dashboard totals against the ledger for sampled workspaces. To validate
classification, sample `activity_log` rows by ID/time under an approved
admin-only procedure; do not export email data.
