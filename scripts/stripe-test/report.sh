#!/usr/bin/env bash
# Snapshot everything a purchase test touched, on both sides of the wire.
#
# Writes one timestamped markdown file per run to scripts/stripe-test/runs/ so a
# whole test matrix leaves an auditable trail that can be read back and analysed
# long after the dev server is gone. Run it after each case in the matrix.
#
# Usage:  ./scripts/stripe-test/report.sh [label]

set -uo pipefail
cd "$(dirname "$0")/../.."
LABEL="${1:-run}"
OUT="scripts/stripe-test/runs/$(date +%Y%m%d-%H%M%S)-${LABEL// /-}.md"
mkdir -p scripts/stripe-test/runs

q() { docker exec supabase_db_MCPEmails psql -U postgres -d postgres -X -P pager=off -c "$1" 2>&1; }
SK=$(grep -m1 '^STRIPE_SECRET_KEY=' apps/web/.env.local | cut -d= -f2-)

{
echo "# Stripe purchase-flow test: $LABEL"
echo
echo "Captured $(date -u '+%Y-%m-%d %H:%M:%SZ')"
echo

echo '## Billing funnel (product_funnel_events)'
echo '```'
q "select occurred_at, stage, outcome, category, error_category
   from product_funnel_events
   where stage in ('pricing_viewed','paywall_reached','checkout_started','checkout_completed','billing_portal_opened')
   order by occurred_at;"
echo '```'

echo '## Plan state (workspaces)'
echo '```'
q "select w.id, u.email, w.plan, w.stripe_customer_id, w.grandfathered, w.updated_at
   from workspaces w left join users u on u.id=w.owner_id
   where w.deleted_at is null order by w.created_at;"
echo '```'

echo '## Subscription state (user_billing)'
echo '```'
q "select b.user_id, u.email, b.plan, b.subscription_status, b.stripe_subscription_id,
          b.current_period_start, b.current_period_end, b.updated_at
   from user_billing b left join users u on u.id=b.user_id order by b.updated_at;"
echo '```'

echo '## Webhook ledger (stripe_webhook_events)'
echo '```'
q "select event_created, event_type, event_id, stripe_customer_id, processed_at
   from stripe_webhook_events order by event_created;"
echo '```'

echo '## Inbox entitlements (should stay empty for seeded buyers)'
echo '```'
q "select e.user_id, u.email, e.unlimited_inboxes, e.kind, e.reason, e.granted_at
   from user_usage_entitlements e left join users u on u.id=e.user_id;"
echo '```'

echo '## Inbox cap hits (error_category = plan_limit)'
echo '```'
q "select occurred_at, stage, category, phase, connection_type
   from product_funnel_events where error_category='plan_limit' order by occurred_at;"
echo '```'

echo '## Stripe side: test-mode subscriptions'
echo '```'
curl -s --max-time 25 -u "$SK:" "https://api.stripe.com/v1/subscriptions?limit=20&status=all" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'error' in d:
    print('ERROR', d['error'].get('message'))
else:
    for s in d.get('data',[]):
        it=s['items']['data'][0]['price']
        print('%s  %-18s cust=%s  %s %s/%s  cancel_at_period_end=%s' % (
            s['id'], s['status'], s['customer'], it['unit_amount'], it['currency'],
            (it.get('recurring') or {}).get('interval'), s.get('cancel_at_period_end')))
    if not d.get('data'): print('(none)')
"
echo '```'

echo '## Stripe side: recent test-mode invoices'
echo '```'
curl -s --max-time 25 -u "$SK:" "https://api.stripe.com/v1/invoices?limit=20" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'error' in d:
    print('ERROR', d['error'].get('message'))
else:
    for i in d.get('data',[]):
        print('%s  %-10s total=%s %s  attempts=%s  sub=%s' % (
            i['id'], i['status'], i['total'], i['currency'],
            i.get('attempt_count'), i.get('subscription')))
    if not d.get('data'): print('(none)')
"
echo '```'
} > "$OUT"

echo "wrote $OUT"
