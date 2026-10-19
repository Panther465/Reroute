#!/usr/bin/env sh
# One image, three roles: api (migrate, optionally seed, then serve), worker, scheduler.
set -eu

role="${1:-api}"

case "$role" in
  api)
    if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
      alembic upgrade head
    fi
    if [ "${SEED_ON_START:-false}" = "true" ]; then
      python -m app.seed
    fi
    exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*' --workers "${API_WORKERS:-2}"
    ;;
  worker)
    # A short TTL keeps each blocking wait at about 45 s. With the default (405 s) the worker treated
    # the end of a long idle wait as a lost Redis connection and quit every 6 3/4 minutes.
    exec rq worker --url "$REDIS_URL" --worker-ttl 60 planning
    ;;
  scheduler)
    exec python -m app.workers.scheduler
    ;;
  *)
    exec "$@"
    ;;
esac
