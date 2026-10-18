#!/bin/sh
# Apply migrations, optionally load the sample routes, then start the API.
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  alembic upgrade head
fi

if [ "${SEED_ON_START:-false}" = "true" ]; then
  python -m app.seed
fi

exec "$@"
