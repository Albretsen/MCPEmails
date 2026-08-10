#!/bin/sh
# ---------------------------------------------------------------------------
# Starts the ext-apps `basic-host` reference host pointed at the fixture server.
#
# The host is NOT vendored into this repo. Point EXT_APPS at a checkout of
# modelcontextprotocol/ext-apps (phase-0 used @92f46a5 / v1.7.5) that has been
# npm-installed and built:
#
#   EXT_APPS=/path/to/ext-apps sh harness/run-host.sh
#
# Then: node harness/fixture-server.mjs   (in another shell)
#       open http://localhost:8080/index.html?tool=fx_outbound_gmail&call=true
#
# NOTE: basic-host's sandbox proxy defaults to :8081. SANDBOX_PROXY_BASE_URL in
# examples/basic-host/src/implementation.ts must match SANDBOX_PORT below, and
# the host must be re-bundled after changing it.
# ---------------------------------------------------------------------------
set -e

: "${EXT_APPS:?set EXT_APPS to an ext-apps checkout}"
: "${FIXTURE_PORT:=3011}"
: "${SANDBOX_PORT:=8091}"

cd "$EXT_APPS/examples/basic-host"
export SERVERS="[\"http://localhost:$FIXTURE_PORT/mcp\"]"
export SANDBOX_PORT
exec npx --yes tsx serve.ts
