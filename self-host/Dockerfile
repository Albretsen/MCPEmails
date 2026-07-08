# MCP Emails, self-host server image.
#
# Runs the exact same Deno MCP server that powers mcpemails.com
# (supabase/functions/mcp-server), plus the provisioning CLI. No build step or
# bundler: the server is plain Deno and talks to PostgREST over HTTP.
#
# Build context is the repo root (see docker-compose.yml) so we can copy both
# the server source and the self-host CLI.
FROM denoland/deno:2.1.4

WORKDIR /app

# Server source (unmodified) + provisioning CLI.
COPY supabase/functions/mcp-server/ ./mcp-server/
COPY self-host/cli/ ./cli/

# Pre-cache remote dependencies (supabase-js, edge-runtime types) at build time
# so startup is offline and fast. Tolerate registry hiccups, Deno re-fetches
# at runtime if needed.
RUN deno cache mcp-server/index.ts ./cli/mcpe.ts || true

# Drop root.
USER deno

EXPOSE 8000

# Deno.serve(handleRequest) binds 0.0.0.0:8000 by default.
CMD ["deno", "run", "--allow-net", "--allow-env", "mcp-server/index.ts"]
