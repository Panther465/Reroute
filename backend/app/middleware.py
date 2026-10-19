"""Request-level guards: trace IDs, body size (413), rate limits (429) and idempotency for every POST.

Idempotency (section 13): every POST body carries `idempotencyKey`. The same key with the same body
replays the first response; the same key with a different body returns 409. Keys last 24 hours.
Auth routes are exempt: replaying a sign-in or token refresh would hand out stored credentials.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import time
import uuid

import redis
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import get_settings
from app.errors import ApiError, error_body
from app.hashing import canonical_body
from app.redis_client import get_redis
from app.security import decode_access_token

log = logging.getLogger("reroute.guard")

IDEMPOTENCY_EXEMPT = ("/v1/auth/",)
#: Live streams must not be buffered or rate limited per event.
STREAMING_SUFFIX = "/live"


def _subject(request: Request) -> str:
    """Who is calling: the access token's subject if it verifies, else the client IP."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        try:
            # Verify the signature: an unverified subject could be forged to read someone else's
            # idempotent responses.
            claims = decode_access_token(auth[7:])
            return "u:" + str(claims["sub"])
        except ApiError:
            pass
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
    return "ip:" + ip


class TraceIdMiddleware:
    """Pure ASGI so it wraps everything, including errors raised by other middleware."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        incoming = headers.get(b"x-request-id", b"").decode("latin-1")
        trace = incoming if 8 <= len(incoming) <= 64 and incoming.replace("-", "").isalnum() else uuid.uuid4().hex
        scope.setdefault("state", {})["trace_id"] = trace

        async def send_with_trace(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"x-request-id", trace.encode()))
            await send(message)

        await self.app(scope, receive, send_with_trace)


class GuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        settings = get_settings()
        trace = getattr(request.state, "trace_id", "")
        path = request.url.path

        # 413: refuse oversized bodies before reading them.
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > settings.max_body_bytes:
            return JSONResponse(error_body("PAYLOAD_TOO_LARGE", "The request body is too large.", trace), status_code=413)

        if not path.startswith("/v1/") or path.endswith("/healthz"):
            return await call_next(request)

        r = get_redis()
        subject = _subject(request)

        # 429: per-user (or per-IP) limits; sign-in routes get a stricter per-IP limit.
        if not path.endswith(STREAMING_SUFFIX):
            is_auth = path.startswith("/v1/auth/")
            limit = settings.auth_rate_limit_per_minute if is_auth else settings.rate_limit_per_minute
            bucket = ("auth:" + _subject_ip(request)) if is_auth else subject
            window = int(time.time() // 60)
            key = f"rl:{bucket}:{window}"
            try:
                count = r.incr(key)
                if count == 1:
                    r.expire(key, 70)
            except redis.RedisError:
                # Fail open: without Redis the limit can't be counted, but the app keeps working.
                log.warning("Rate limiter unavailable", extra={"traceId": trace})
                count = 0
            if count > limit:
                return JSONResponse(
                    error_body("RATE_LIMITED", "Too many requests. Wait a minute and try again.", trace),
                    status_code=429,
                    headers={"Retry-After": str(60 - int(time.time()) % 60)},
                )

        if request.method != "POST" or path.startswith(IDEMPOTENCY_EXEMPT):
            return await call_next(request)

        # Idempotency for every other POST.
        raw = await request.body()
        if len(raw) > settings.max_body_bytes:
            return JSONResponse(error_body("PAYLOAD_TOO_LARGE", "The request body is too large.", trace), status_code=413)
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return JSONResponse(error_body("BAD_REQUEST", "The body must be JSON.", trace), status_code=400)
        key = body.get("idempotencyKey") if isinstance(body, dict) else None
        if not isinstance(key, str) or not key:
            # Let validation report the missing field in the usual shape.
            return await call_next(request)

        body_hash = hashlib.sha256((path + "\n" + canonical_body(body)).encode()).hexdigest()
        store_key = f"idem:reroute:{subject}:{key}"
        lock_key = store_key + ":lock"
        try:
            stored = r.get(store_key)
            locked = stored is not None or bool(r.set(lock_key, "1", nx=True, ex=30))
        except redis.RedisError:
            # Without Redis there is no replay store; the database's own unique keys still stop
            # duplicate check-ins, so the request goes ahead rather than failing.
            log.warning("Idempotency store unavailable", extra={"traceId": trace})
            return await call_next(request)
        if not locked:
            return JSONResponse(error_body("CONFLICT", "The same request is already being processed.", trace), status_code=409)
        if stored is not None:
            saved = json.loads(stored)
            if saved["hash"] != body_hash:
                return JSONResponse(
                    error_body("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with a different request.", trace), status_code=409
                )
            return Response(saved["body"], status_code=saved["status"], media_type="application/json", headers={"Idempotent-Replayed": "true"})

        try:
            response = await call_next(request)
            chunks = [chunk async for chunk in response.body_iterator]  # type: ignore[attr-defined]
            content = b"".join(c if isinstance(c, bytes) else c.encode() for c in chunks)
            if response.status_code < 500:
                try:
                    r.set(
                        store_key,
                        json.dumps({"hash": body_hash, "status": response.status_code, "body": content.decode()}),
                        ex=settings.idempotency_ttl_seconds,
                    )
                except redis.RedisError:
                    log.warning("Couldn't store an idempotent response", extra={"traceId": trace})
            headers = {k: v for k, v in response.headers.items() if k.lower() not in ("content-length",)}
            return Response(content, status_code=response.status_code, headers=headers, media_type=response.media_type)
        finally:
            with contextlib.suppress(redis.RedisError):
                r.delete(lock_key)


def _subject_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else "unknown")
