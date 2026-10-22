"""One error shape for every failure: {"error": {"code", "message", "traceId"}}."""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("reroute")

_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    410: "GONE",
    413: "PAYLOAD_TOO_LARGE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL",
}


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None, headers: dict[str, str] | None = None, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code or _CODES.get(status, "ERROR")
        self.message = message
        self.headers = headers
        #: Detail for a worker's result (such as the blocked task); not part of the HTTP error body.
        self.extra = extra or {}


def trace_id(request: Request) -> str:
    return getattr(request.state, "trace_id", "")


def error_body(code: str, message: str, trace: str) -> dict:
    return {"error": {"code": code, "message": message, "traceId": trace}}


def error_response(request: Request, status: int, code: str, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(error_body(code, message, trace_id(request)), status_code=status, headers=headers)


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):
        return error_response(request, exc.status, exc.code, exc.message, exc.headers)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return error_response(request, exc.status_code, _CODES.get(exc.status_code, "ERROR"), message, getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        message = f"{where}: {first.get('msg', 'Invalid input')}" if where else str(first.get("msg", "Invalid input"))
        return error_response(request, 422, "VALIDATION_ERROR", message)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception):
        log.exception("Unhandled error", extra={"traceId": trace_id(request)})
        return error_response(request, 500, "INTERNAL", "Something went wrong on our side. Try again.")
