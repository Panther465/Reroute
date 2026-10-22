"""ASGI middleware: request IDs, the body-size limit and idempotent POSTs.

Written as plain ASGI so request bodies can be read once and replayed to the app.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

from redis import Redis
from redis.exceptions import RedisError

from app.config import get_settings
from app.errors import error_body, trace_id_var
from app.security import bearer_token, decode_access_token

log = logging.getLogger("raasta")
access_log = logging.getLogger("raasta.access")

#: Caller-chosen trace IDs are kept to characters that can't forge a log field.
_TRACE_ID = re.compile(r"[A-Za-z0-9._:-]{8,128}")

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

IDEMPOTENCY_TTL_S = 24 * 60 * 60
PENDING_TTL_S = 60


async def _send_json(send: Send, status: int, payload: dict, extra_headers: list[tuple[bytes, bytes]] | None = None) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *(extra_headers or [])]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return value.decode("latin-1")
    return None


class RequestIdMiddleware:
    """Use the caller's X-Request-ID as the trace ID, or make one, and echo it back.

    It also answers unhandled exceptions, so the 500 body and the X-Request-ID header carry the
    trace ID that the error log shows, and it writes the access log (uvicorn's is off): one line
    per request with the method, the path without its query string (queries carry coordinates),
    the status, the time taken and the trace ID.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = _header(scope, b"x-request-id")
        trace_id = incoming if incoming and _TRACE_ID.fullmatch(incoming) else uuid.uuid4().hex
        token = trace_id_var.set(trace_id)
        started = time.perf_counter()
        response: dict[str, Any] = {"status": 500, "started": False}

        async def send_with_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                response.update(status=message["status"], started=True)
                headers = [h for h in message.get("headers", []) if h[0].lower() != b"x-request-id"]
                message = {**message, "headers": [*headers, (b"x-request-id", trace_id.encode())]}
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            log.exception("unhandled error trace=%s", trace_id)
            if response["started"]:
                raise
            await _send_json(send_with_id, 500, error_body("INTERNAL", "Something went wrong on our side. Try again.", trace_id))
        finally:
            elapsed_ms = (time.perf_counter() - started) * 1000
            access_log.info("%s %s %d %.0fms trace=%s", scope.get("method", ""), _masked_path(scope), response["status"], elapsed_ms, trace_id)
            trace_id_var.reset(token)


def _masked_path(scope: Scope) -> str:
    """The path without its query string, percent-encoded so it can't break the log line."""
    return quote(scope.get("path", ""), safe="/-._~:@")


async def _read_body(receive: Receive, limit: int) -> bytes | None:
    """The whole body, or None once it grows past `limit` bytes."""
    chunks: list[bytes] = []
    size = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


def _replay(body: bytes) -> Receive:
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


class BodyLimitAndIdempotencyMiddleware:
    """413 above MAX_BODY_BYTES, and idempotent POSTs keyed on the body's `idempotencyKey`.

    The same key with the same body returns the first response again (header
    Idempotent-Replayed: true). The same key with a different body returns 409. Keys are kept
    for 24 hours, scoped to the signed-in user.
    """

    def __init__(self, app: ASGIApp, redis_getter: Callable[[], Redis], max_body_bytes: int | None = None, namespace: str = "raasta") -> None:
        self.app = app
        self.redis_getter = redis_getter
        self.max_body_bytes = max_body_bytes
        self.namespace = namespace

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return
        limit = self.max_body_bytes or get_settings().max_body_bytes
        declared = _header(scope, b"content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            await _send_json(send, 413, error_body("PAYLOAD_TOO_LARGE", f"The request body is larger than {limit} bytes."))
            return
        body = await _read_body(receive, limit)
        if body is None:
            await _send_json(send, 413, error_body("PAYLOAD_TOO_LARGE", f"The request body is larger than {limit} bytes."))
            return
        if scope["method"] != "POST":
            await self.app(scope, _replay(body), send)
            return
        await self._idempotent(scope, body, send)

    async def _idempotent(self, scope: Scope, body: bytes, send: Send) -> None:
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = None
        key = None
        if isinstance(parsed, dict):
            # Bodies also accept the snake_case field name, so both spellings are keys.
            key = parsed.get("idempotencyKey")
            if key is None:
                key = parsed.get("idempotency_key")
        if not isinstance(key, str) or not 4 <= len(key) <= 128:
            # Validation reports the missing or malformed key with the usual 422.
            await self.app(scope, _replay(body), send)
            return

        token = bearer_token(_header(scope, b"authorization"))
        user = decode_access_token(token, get_settings()) if token else None
        owner = user.user_id if user else "anon"
        redis_key = f"idem:{self.namespace}:{owner}:{key}"
        # The method and path are part of the request: the same key and body sent to another route is a different request.
        signature = f"{scope.get('method', '')} {scope.get('path', '')}\n" + json.dumps(parsed, sort_keys=True, separators=(",", ":"))
        body_hash = hashlib.sha256(signature.encode()).hexdigest()

        try:
            redis = self.redis_getter()
            stored_raw = redis.get(redis_key)
            if stored_raw is None:
                placed = redis.set(redis_key, json.dumps({"state": "pending", "hash": body_hash}), nx=True, ex=PENDING_TTL_S)
                if not placed:
                    stored_raw = redis.get(redis_key)
        except RedisError:
            log.warning("idempotency store unavailable; refusing POST", extra={"key": redis_key})
            await _send_json(send, 500, error_body("INTERNAL", "Couldn't check this request for repeats. Try again."))
            return

        if stored_raw is not None:
            stored = json.loads(stored_raw)
            if stored.get("hash") != body_hash:
                await _send_json(send, 409, error_body("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with a different request body."))
                return
            if stored.get("state") == "pending":
                # Its own code, so a client keeps the same key and retries instead of starting a new request.
                await _send_json(send, 409, error_body("IN_PROGRESS", "The first request with this idempotency key is still running. Try again shortly."))
                return
            payload = stored["body"].encode()
            headers = [
                (b"content-type", stored.get("contentType", "application/json").encode()),
                (b"content-length", str(len(payload)).encode()),
                (b"idempotent-replayed", b"true"),
            ]
            await send({"type": "http.response.start", "status": stored["status"], "headers": headers})
            await send({"type": "http.response.body", "body": payload})
            return

        captured: dict[str, Any] = {"status": 500, "headers": [], "body": b""}

        async def capture(message: Message) -> None:
            if message["type"] == "http.response.start":
                captured["status"] = message["status"]
                captured["headers"] = message.get("headers", [])
            elif message["type"] == "http.response.body":
                captured["body"] += message.get("body", b"")
            await send(message)

        try:
            await self.app(scope, _replay(body), capture)
        except Exception:
            self._forget(redis_key)
            raise
        status = captured["status"]
        # Server errors, auth failures and rate limits aren't final answers: let a retry run again.
        if status >= 500 or status in (401, 403, 429):
            self._forget(redis_key)
            return
        content_type = next((v.decode() for k, v in captured["headers"] if k.lower() == b"content-type"), "application/json")
        record = {"state": "done", "hash": body_hash, "status": status, "contentType": content_type, "body": captured["body"].decode("utf-8", "replace")}
        try:
            self.redis_getter().set(redis_key, json.dumps(record), ex=IDEMPOTENCY_TTL_S)
        except RedisError:
            log.warning("couldn't store idempotent response", extra={"key": redis_key})

    def _forget(self, redis_key: str) -> None:
        with contextlib.suppress(RedisError):
            self.redis_getter().delete(redis_key)
