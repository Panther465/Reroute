"""Firebase Cloud Messaging (HTTP v1): push notifications to the Android app.

The server signs in to Google as a service account (the OAuth 2.0 JWT bearer grant: a JWT signed with the
account's private key) and keeps the access token in Redis until a minute before it expires, so every worker
process shares one. Each alert goes to a phone as a high-priority data message, which the app shows itself
(RerouteMessagingService): with the same notification number as the alerts it raises on its own, so a push
and the app's own alert for the same moment replace each other instead of stacking.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

import httpx
import jwt

from app.config import get_settings
from app.redis_client import get_redis

log = logging.getLogger("reroute.fcm")

SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
SEND_URL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send"
TOKEN_URI = "https://oauth2.googleapis.com/token"
#: Redis key prefix for the access token (an hour's credential to send pushes, nothing more), one per service
#: account key, so a new key or another Firebase project never picks up the old one's token.
ACCESS_TOKEN_KEY = "fcm:access_token"
#: Firebase's answers for a token that will never work again: the app was uninstalled, or the token belongs
#: to another Firebase project. Anything else (a busy server, a bad message) leaves the phone registered.
GONE = frozenset({"UNREGISTERED", "SENDER_ID_MISMATCH"})

Outcome = Literal["sent", "gone", "failed"]


@dataclass(frozen=True)
class ServiceAccount:
    project_id: str
    client_email: str
    private_key: str
    private_key_id: str
    token_uri: str

    @property
    def cache_key(self) -> str:
        who = hashlib.sha256(f"{self.client_email} {self.private_key_id}".encode()).hexdigest()[:16]
        return f"{ACCESS_TOKEN_KEY}:{who}"


def load_account(path: str) -> ServiceAccount | None:
    """The service account key at `path`, or None when push isn't set up (no path, or a placeholder without a key)."""
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        log.warning("FCM_CREDENTIALS_FILE isn't a readable JSON key: push notifications are off")
        return None
    if not isinstance(raw, dict) or raw.get("type") != "service_account" or not all(raw.get(k) for k in ("project_id", "client_email", "private_key")):
        if raw:
            # Not the empty placeholder: most likely the app's google-services.json in place of the server's key.
            log.error("FCM_CREDENTIALS_FILE isn't a service account key (google-services.json is the app's, not the server's)")
        return None
    return ServiceAccount(
        project_id=raw["project_id"],
        client_email=raw["client_email"],
        private_key=raw["private_key"],
        private_key_id=raw.get("private_key_id") or "",
        token_uri=raw.get("token_uri") or TOKEN_URI,
    )


@lru_cache
def configured_account() -> ServiceAccount | None:
    return load_account(get_settings().fcm_credentials_file)


def error_code(res: httpx.Response) -> str:
    """Firebase's own reason in an error answer, e.g. UNREGISTERED."""
    try:
        details = res.json().get("error", {}).get("details", [])
    except ValueError:
        return ""
    for d in details if isinstance(details, list) else []:
        if isinstance(d, dict) and str(d.get("@type", "")).endswith("FcmError"):
            return str(d.get("errorCode", ""))
    return ""


class Fcm:
    def __init__(self, account: ServiceAccount, client: httpx.Client | None = None) -> None:
        self.account = account
        self.http = client or httpx.Client(timeout=httpx.Timeout(8.0, connect=4.0))

    def access_token(self, fresh: bool = False) -> str:
        r = get_redis()
        if not fresh and (cached := r.get(self.account.cache_key)):
            return cached
        now = int(time.time())
        claims = {"iss": self.account.client_email, "scope": SCOPE, "aud": self.account.token_uri, "iat": now, "exp": now + 3600}
        headers = {"kid": self.account.private_key_id} if self.account.private_key_id else None
        assertion = jwt.encode(claims, self.account.private_key, algorithm="RS256", headers=headers)
        res = self.http.post(self.account.token_uri, data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
        if res.status_code != 200:
            raise httpx.HTTPStatusError(f"Google refused the service account sign-in ({res.status_code})", request=res.request, response=res)
        body = res.json()
        token = str(body["access_token"])
        r.set(self.account.cache_key, token, ex=max(60, int(body.get("expires_in", 3600)) - 60))
        return token

    def send(self, token: str, data: dict[str, str], ttl_seconds: int) -> Outcome:
        """One data message to one phone. Firebase keeps trying a phone that's off for `ttl_seconds`, then drops it."""
        message = {"message": {"token": token, "data": data, "android": {"priority": "HIGH", "ttl": f"{max(0, ttl_seconds)}s"}}}
        url = SEND_URL.format(project=self.account.project_id)
        for fresh in (False, True):
            try:
                res = self.http.post(url, json=message, headers={"Authorization": f"Bearer {self.access_token(fresh=fresh)}"})
            except (httpx.HTTPError, KeyError, ValueError) as exc:
                log.warning("Couldn't send a push through Firebase: %s", exc)
                return "failed"
            if res.status_code == 200:
                return "sent"
            # A cached access token that stopped working before its time: sign in again, once.
            if res.status_code == 401 and not fresh:
                continue
            code = error_code(res)
            if code in GONE:
                return "gone"
            log.warning("Firebase refused a push", extra={"status": res.status_code, "fcmError": code})
            return "failed"
        return "failed"
