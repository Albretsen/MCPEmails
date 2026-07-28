# MCP Emails self-hosted MCP server.
#
# This root-level Dockerfile lets MCP directories such as Glama build and
# evaluate the open-source server directly from the repository root.
FROM denoland/deno:2.1.4

WORKDIR /app

COPY supabase/functions/mcp-server/ ./mcp-server/
COPY self-host/cli/ ./cli/

RUN deno cache mcp-server/index.ts ./cli/mcpe.ts || true

USER deno

EXPOSE 8000

CMD ["deno", "run", "--allow-net", "--allow-env", "mcp-server/index.ts"]
