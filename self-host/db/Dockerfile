# Postgres image with the self-host schema baked in.
#
# We bake the init scripts into the image rather than bind-mounting them so the
# stack behaves identically on Linux and macOS, macOS bind mounts are often
# `noexec` and report files as executable, which makes the postgres entrypoint
# try (and fail) to exec a shell init script. On the image's own filesystem
# there is no such ambiguity.
FROM postgres:16-alpine

# Schema first, then the role-password script (lexical order = run order).
COPY 00-schema.sql /docker-entrypoint-initdb.d/00-schema.sql
COPY 01-roles.sh   /docker-entrypoint-initdb.d/01-roles.sh

# Strip the execute bit so the postgres entrypoint *sources* the script (`. file`)
# instead of exec'ing it, no dependency on the shebang or interpreter path.
RUN chmod -x /docker-entrypoint-initdb.d/01-roles.sh
