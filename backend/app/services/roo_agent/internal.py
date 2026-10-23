"""Roo calls the app's own API, in this process, signed in as the traveller.

So Roo can do exactly what the traveller can, no more: every call passes the same sign-in, ownership checks,
validation and idempotency as the app's own. Its calls skip only the per-minute limit (see middleware.py).
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import FastAPI

from app.security import ROO_STEP_HEADER, ROO_STEP_SECRET


class CallFailed(Exception):
    """The API said no: its status, error code and the message it gives the traveller."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class InternalApi:
    def __init__(self, app: FastAPI, authorization: str):
        self._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://reroute.internal",
            headers={"authorization": authorization, ROO_STEP_HEADER: ROO_STEP_SECRET},
            timeout=60.0,
        )

    async def __aenter__(self) -> InternalApi:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._client.aclose()

    async def get(self, path: str, **params: Any) -> Any:
        return await self._send("GET", path, params=_query(params))

    async def post(self, path: str, body: dict[str, Any], key: str, **params: Any) -> Any:
        return await self._send("POST", path, json={**body, "idempotencyKey": key}, params=_query(params))

    async def patch(self, path: str, body: dict[str, Any]) -> Any:
        return await self._send("PATCH", path, json=body)

    async def delete(self, path: str) -> Any:
        return await self._send("DELETE", path)

    async def _send(self, method: str, path: str, **kw: Any) -> Any:
        res = await self._client.request(method, path, **kw)
        if res.status_code >= 400:
            try:
                err = res.json()["error"]
            except (ValueError, LookupError, TypeError):
                err = {}
            raise CallFailed(res.status_code, str(err.get("code", "ERROR")), str(err.get("message", "That didn't work.")))
        return res.json() if res.content else None


def _query(params: dict[str, Any]) -> dict[str, str]:
    return {k: ("true" if v else "false") if isinstance(v, bool) else str(v) for k, v in params.items() if v is not None}
