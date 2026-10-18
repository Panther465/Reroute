"""Access tokens are issued by the Reroute API; Raasta only verifies them."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import jwt
from fastapi import Depends, Request

from app.config import Settings, get_settings
from app.errors import ApiError

Role = Literal["traveller", "moderator", "admin"]


@dataclass(frozen=True, slots=True)
class User:
    user_id: str
    role: Role

    @property
    def is_moderator(self) -> bool:
        return self.role in ("moderator", "admin")


def decode_access_token(token: str, settings: Settings) -> User | None:
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=["HS256"],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            options={"require": ["exp", "sub", "iss", "aud"]},
        )
    except jwt.PyJWTError:
        return None
    if claims.get("typ") != "access" or claims.get("role") not in ("traveller", "moderator", "admin"):
        return None
    return User(user_id=str(claims["sub"]), role=claims["role"])


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def optional_user(request: Request, settings: Settings = Depends(get_settings)) -> User | None:
    token = bearer_token(request.headers.get("authorization"))
    return decode_access_token(token, settings) if token else None


def require_user(user: User | None = Depends(optional_user)) -> User:
    if user is None:
        raise ApiError(401, "UNAUTHENTICATED", "Sign in to do this.", {"WWW-Authenticate": "Bearer"})
    return user


def require_moderator(user: User = Depends(require_user)) -> User:
    if not user.is_moderator:
        raise ApiError(403, "FORBIDDEN", "Only moderators can do this.")
    return user
