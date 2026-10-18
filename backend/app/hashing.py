"""Canonical JSON for hashing request bodies (idempotency) and planner inputs."""

from __future__ import annotations

from app.services.planner.hashing import canonical_json


def canonical_body(body: object) -> str:
    """The body without its idempotency key, as canonical JSON."""
    if isinstance(body, dict):
        body = {k: v for k, v in body.items() if k != "idempotencyKey"}
    return canonical_json(body)
