#!/usr/bin/env bash
# Create a confirmed test user in the LOCAL Supabase, ready to buy a plan.
#
# Goes through the auth admin API rather than raw SQL so the on_auth_user_created
# trigger fires and builds the same three rows a real signup does: public.users,
# public.workspaces, public.workspace_members. It deliberately does NOT create a
# user_usage_entitlements row, which is what makes the seeded account behave like
# a post-repricing signup: capped at 1 inbox, paywall reachable.
#
# Usage:  ./scripts/stripe-test/seed-user.sh [email]
# Default email is unique per run so tests never collide on the users.email key.

set -euo pipefail
API="${NEXT_PUBLIC_SUPABASE_URL:-http://127.0.0.1:54321}"
SR="${SUPABASE_SERVICE_ROLE_KEY:?run: source scripts/stripe-test/env.sh first}"

if [[ "$API" != *"127.0.0.1"* && "$API" != *"localhost"* ]]; then
  echo "REFUSING: NEXT_PUBLIC_SUPABASE_URL is not local ($API)." >&2
  echo "Seeding users into production is never what you want." >&2
  exit 1
fi

EMAIL="${1:-buyer+$(date +%s)@stripe-test.local}"
PASSWORD="test-password-123"

RESP=$(curl -s --max-time 20 -X POST "$API/auth/v1/admin/users" \
  -H "apikey: $SR" -H "Authorization: Bearer $SR" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"email_confirm\":true}")

python3 - "$RESP" "$EMAIL" "$PASSWORD" <<'PY'
import sys, json
resp, email, password = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.loads(resp)
if 'id' not in d:
    print('FAILED:', d.get('msg') or d.get('error_description') or d)
    sys.exit(1)
print('user_id :', d['id'])
print('email   :', email)
print('password:', password)
print()
print('Sign in at http://localhost:3000 with those credentials, then go to /pricing.')
PY
