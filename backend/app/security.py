"""Tokens (section 15.3).

- Access token: a 15-minute JWT sent in the Authorization header.
- Refresh token: random, stored hashed, in an httpOnly Secure SameSite=Strict cookie, rotated on every
  use. Reusing a rotated token revokes its whole family (theft detection).
- The refresh and logout calls also need a CSRF token (double submit: cookie + X-CSRF-Token header).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Response
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import ApiError
from app.models import RefreshToken, User, new_id

ISSUER = "reroute"
AUDIENCE = "reroute-api"
REFRESH_COOKIE = "rr_refresh"
CSRF_COOKIE = "rr_csrf"
CSRF_HEADER = "X-CSRF-Token"


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def issue_access_token(user: User, now: datetime | None = None) -> tuple[str, int]:
    s = get_settings()
    now = now or datetime.now(UTC)
    ttl = s.access_token_minutes * 60
    claims = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "sub": user.user_id,
        "role": user.role,
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
    }
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256"), ttl


def decode_access_token(token: str) -> dict:
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"], audience=AUDIENCE, issuer=ISSUER)
    except jwt.ExpiredSignatureError as exc:
        raise ApiError(401, "Your session expired. Sign in again.", headers={"WWW-Authenticate": "Bearer"}) from exc
    except jwt.InvalidTokenError as exc:
        raise ApiError(401, "Sign in to continue.", headers={"WWW-Authenticate": "Bearer"}) from exc
    if claims.get("typ") != "access":
        raise ApiError(401, "Sign in to continue.")
    return claims


def _set_cookies(response: Response, refresh: str, csrf: str, max_age: int) -> None:
    secure = get_settings().cookie_secure
    response.set_cookie(REFRESH_COOKIE, refresh, max_age=max_age, httponly=True, secure=secure, samesite="strict", path="/v1/auth")
    response.set_cookie(CSRF_COOKIE, csrf, max_age=max_age, httponly=False, secure=secure, samesite="strict", path="/")


def clear_cookies(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/v1/auth")
    response.delete_cookie(CSRF_COOKIE, path="/")


def start_session(db: Session, user: User, response: Response, family_id: str | None = None) -> None:
    """Issue a new refresh token (and CSRF token) as cookies."""
    s = get_settings()
    raw = secrets.token_urlsafe(32)
    max_age = s.refresh_token_days * 24 * 3600
    db.add(
        RefreshToken(
            user_id=user.user_id,
            family_id=family_id or new_id("fam"),
            token_hash=sha256(raw),
            expires_at=datetime.now(UTC) + timedelta(seconds=max_age),
        )
    )
    _set_cookies(response, raw, secrets.token_urlsafe(24), max_age)


def check_csrf(cookie_value: str | None, header_value: str | None) -> None:
    if not cookie_value or not header_value or not hmac.compare_digest(cookie_value, header_value):
        raise ApiError(403, "Missing or wrong CSRF token.", code="CSRF")


def rotate_refresh(db: Session, raw: str | None, response: Response) -> User:
    if not raw:
        raise ApiError(401, "Sign in to continue.")
    token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(raw)))
    now = datetime.now(UTC)
    if token is None:
        raise ApiError(401, "Sign in to continue.")
    if token.revoked_at is not None:
        # A rotated token came back: someone may have copied it. Revoke the whole family.
        db.execute(update(RefreshToken).where(RefreshToken.family_id == token.family_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))
        db.commit()
        raise ApiError(401, "Your session ended. Sign in again.")
    if token.expires_at <= now:
        raise ApiError(401, "Your session expired. Sign in again.")
    token.revoked_at = now
    user = db.get(User, token.user_id)
    if user is None:
        raise ApiError(401, "Sign in to continue.")
    start_session(db, user, response, family_id=token.family_id)
    db.commit()
    return user


def revoke_refresh(db: Session, raw: str | None) -> None:
    if not raw:
        return
    token = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256(raw)))
    if token is not None:
        now = datetime.now(UTC)
        db.execute(update(RefreshToken).where(RefreshToken.family_id == token.family_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))
        db.commit()


def new_share_token() -> str:
    """128 random bits, URL-safe. Only its hash is stored."""
    return secrets.token_urlsafe(16)
