#!/bin/sh
# Sets the login password for the PostgREST `authenticator` role from the
# AUTHENTICATOR_PASSWORD env var, so it is never hard-coded in SQL or committed.
# Runs after 00-schema.sql (init scripts execute in lexical order).
#
# POSIX sh (not bash): the postgres:*-alpine image ships busybox ash only.
set -eu

if [ -z "${AUTHENTICATOR_PASSWORD:-}" ]; then
  echo "01-roles.sh: AUTHENTICATOR_PASSWORD is not set, aborting." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "ALTER ROLE authenticator WITH PASSWORD '${AUTHENTICATOR_PASSWORD}';"

echo "01-roles.sh: authenticator password set."
