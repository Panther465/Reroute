"""Crash and error reports to Sentry, only with SENTRY_DSN set (docs/data-and-privacy.md says what goes).

A report carries the error, its stack, the API path and the trace ID. Never a name, email, password, token,
query string, request body or cookie: Sentry is told not to collect them, and `scrub` takes out what's left.
"""

from __future__ import annotations

import os
from typing import Any

from app.config import get_settings

#: Request headers a report may keep. Everything else (Authorization, Cookie, X-CSRF-Token…) goes.
_KEEP_HEADERS = {"user-agent", "x-request-id", "x-reroute-client", "content-type", "accept"}


def scrub(event: dict[str, Any], _hint: dict[str, Any] | None = None) -> dict[str, Any]:
    """Keep a report to the error and where it happened."""
    from app.middleware import masked_path

    request = event.get("request")
    if isinstance(request, dict):
        for field in ("query_string", "cookies", "data", "env"):
            request.pop(field, None)
        url = request.get("url")
        if isinstance(url, str):
            # Share links carry their secret in the path.
            scheme, sep, rest = url.partition("://")
            host, slash, path = rest.partition("/")
            request["url"] = f"{scheme}{sep}{host}{masked_path(slash + path.split('?', 1)[0])}" if sep else masked_path(url.split("?", 1)[0])
        headers = request.get("headers")
        if isinstance(headers, dict):
            request["headers"] = {k: v for k, v in headers.items() if k.lower() in _KEEP_HEADERS}
    # Only the account ID, never who they are.
    user = event.get("user")
    if isinstance(user, dict):
        event["user"] = {"id": user["id"]} if "id" in user else {}
    return event


def start(component: str) -> bool:
    """Start reporting for this process (the API, the worker or the scheduler). False when SENTRY_DSN is empty."""
    s = get_settings()
    if not s.sentry_dsn:
        return False
    import sentry_sdk  # only loaded where reports are on

    sentry_sdk.init(
        dsn=s.sentry_dsn,
        environment=s.app_env,
        release=os.environ.get("APP_VERSION") or None,
        send_default_pii=False,
        # Values in a stack frame can be a password being checked: never send them.
        include_local_variables=False,
        max_request_body_size="never",
        traces_sample_rate=s.sentry_traces_sample_rate,
        before_send=scrub,
        before_send_transaction=scrub,
    )
    sentry_sdk.set_tag("component", component)
    return True
