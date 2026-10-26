#!/usr/bin/env bash
# deploy-mcp-server.sh
# Deploy the mcp-server Edge Function to one Supabase project.
#
# Prerequisites:
#   - Supabase CLI installed: https://supabase.com/docs/guides/cli/getting-started
#   - Logged in: supabase login
#
# Usage (from repo root), the project ref is required:
#   bash scripts/deploy-mcp-server.sh <project-ref>
#
# Production is swvaxorwumispmjaaszb; staging is the SUPABASE_REF_STAGING repo
# variable. Deploy from a clean worktree at the pushed SHA (see CLAUDE.md), or
# use the deploy-edge-function.yml workflow.

set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: bash scripts/deploy-mcp-server.sh <project-ref>" >&2
  exit 64
fi
PROJECT_REF="$1"

FUNCTION_NAME="mcp-server"
FUNCTION_DIR="supabase/functions/${FUNCTION_NAME}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Deploying ${FUNCTION_NAME} from ${REPO_ROOT}/${FUNCTION_DIR} to ${PROJECT_REF}"

cd "${REPO_ROOT}"

supabase functions deploy "${FUNCTION_NAME}" \
  --no-verify-jwt \
  --project-ref "${PROJECT_REF}"

echo "==> Done. Function deployed successfully."
