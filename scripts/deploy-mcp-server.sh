#!/usr/bin/env bash
# deploy-mcp-server.sh
# Deploy the mcp-server Edge Function to Supabase.
#
# Prerequisites:
#   - Supabase CLI installed: https://supabase.com/docs/guides/cli/getting-started
#   - Logged in: supabase login
#   - Project linked: supabase link --project-ref swvaxorwumispmjaaszb
#
# Usage (from repo root):
#   bash scripts/deploy-mcp-server.sh

set -euo pipefail

FUNCTION_NAME="mcp-server"
FUNCTION_DIR="supabase/functions/${FUNCTION_NAME}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Deploying ${FUNCTION_NAME} from ${REPO_ROOT}/${FUNCTION_DIR}"

cd "${REPO_ROOT}"

supabase functions deploy "${FUNCTION_NAME}" \
  --no-verify-jwt \
  --project-ref swvaxorwumispmjaaszb

echo "==> Done. Function deployed successfully."
