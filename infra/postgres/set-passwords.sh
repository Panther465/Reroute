#!/usr/bin/env bash
# Runs after init.sql on first start. Replaces the development passwords when the
# deployment provides its own.
set -euo pipefail

if [[ -n "${REROUTE_DB_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "ALTER ROLE reroute_app PASSWORD '${REROUTE_DB_PASSWORD//\'/\'\'}';"
fi
if [[ -n "${RAASTA_DB_PASSWORD:-}" ]]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "ALTER ROLE raasta_app PASSWORD '${RAASTA_DB_PASSWORD//\'/\'\'}';"
fi
