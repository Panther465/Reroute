"""Loaded by `rq worker -c app.workers.rq_settings` in the worker's main process: error reports (SENTRY_DSN) start here."""

from app.monitoring import start

start("worker")
