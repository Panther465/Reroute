"""Alerts as push notifications to the traveller's phones: the Android app, through Firebase Cloud Messaging.

The live stream reaches the app while it's open, but Android cuts a background app's network a few seconds
after it leaves the screen and freezes it soon after. So the alerts the web app shows as notifications also go
out as pushes: leave-by (10 minutes before and at the time) and the morning plan. Each is its own job, so a slow
answer from Firebase never holds up planning, and the words are the ones the app would show itself. Rico's
check-ins go out the same way: a hello, with what the app needs to say why once it's opened.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import delete, exists, select

from app.adapters import fcm
from app.config import get_settings
from app.db import session_scope
from app.models import PushDevice, RefreshToken
from app.redis_client import get_redis
from app.workers.queue import get_queue

log = logging.getLogger("reroute.push")


@dataclass(frozen=True)
class PushAlert:
    kind: Literal["leave_now", "morning", "nudge"]
    body: str
    #: Groups notifications on the phone: a newer one with the same tag replaces the older, as on the web.
    tag: str
    trip_id: str
    #: How long the alert is worth showing, from when it's raised. Firebase keeps trying a phone that's off
    #: until then, and drops it after.
    ttl_seconds: int
    title: str = "Reroute"
    seq: int | None = None
    #: More for the app to read when the alert is opened (a nudge's reason and times), as text: Firebase carries
    #: only strings. The fields above win over any of the same name.
    details: dict[str, str] = field(default_factory=dict)


def enabled() -> bool:
    """This process holds the key and sends the pushes (the worker, under Docker Compose)."""
    return fcm.configured_account() is not None


#: Set by the worker when it starts with a usable key (announce()), so the API, which never holds the key,
#: knows the pushes really go out.
READY_KEY = "push:worker_ready"


def offered() -> bool:
    """Phones get pushes from this deployment: the key is here, or FCM_PUSH is on and the worker has loaded it."""
    return enabled() or (get_settings().fcm_push and bool(get_redis().exists(READY_KEY)))


def announce() -> bool:
    """Run as the worker starts: say whether this deployment can send pushes."""
    r = get_redis()
    account = fcm.configured_account()
    if account is None:
        r.delete(READY_KEY)
        if get_settings().fcm_push:
            log.error("FCM_SERVICE_ACCOUNT is set but the worker has no usable Firebase key: no pushes go out")
        return False
    r.set(READY_KEY, account.project_id)
    log.info("Push notifications are on", extra={"project": account.project_id})
    return True


#: Tests replace this with a fake Firebase.
sender_factory = fcm.Fcm


def alert(user_id: str, item: PushAlert) -> None:
    """Queue `item` for each of the traveller's phones, when push is set up on this server.

    Its time to live counts from now, not from when the job runs: a queue that falls behind sends a leave-by
    alert for what's left of its time, or not at all.
    """
    if enabled():
        expires = datetime.now(UTC) + timedelta(seconds=item.ttl_seconds)
        get_queue().enqueue(deliver, user_id, {**asdict(item), "expires_ms": int(expires.timestamp() * 1000)})


def leave_text(in_min: int, label: str) -> str:
    """The leave-by alert, in the words the app shows for the live stream's event."""
    return f"Leave in {in_min} min. {label}." if in_min > 0 else f"Leave now. {label}."


#: Rico's check-in. The push only says hello: the app says why when it's opened.
NUDGE_TEXT = "Hi, are you there? 👋"


def deliver(user_id: str, item: dict, now: datetime | None = None) -> dict:
    """The push job: one message to each phone still signed in. Phones Firebase says are gone for good, and
    phones whose sign-in has ended (signed out, expired, or cut off by the theft check), are forgotten."""
    account = fcm.configured_account()
    if account is None:
        return {"sent": 0, "gone": 0}
    now = now or datetime.now(UTC)
    now_ms = int(now.timestamp() * 1000)
    expires_ms = item.get("expires_ms") or now_ms + item["ttl_seconds"] * 1000
    left = (expires_ms - now_ms) // 1000
    if left < 1:
        log.info("Dropped a push that waited past its time", extra={"kind": item["kind"]})
        return {"sent": 0, "gone": 0}
    with session_scope() as db:
        live = set(db.scalars(_signed_in(now).where(RefreshToken.user_id == user_id)))
        phones, ended = [], []
        for d in db.scalars(select(PushDevice).where(PushDevice.user_id == user_id)):
            # A phone registered before sign-ins were recorded with it counts while the traveller has any.
            signed_in = d.family_id in live if d.family_id else bool(live)
            (phones if signed_in else ended).append((d.device_id, d.token))
        if ended:
            db.execute(delete(PushDevice).where(PushDevice.device_id.in_([device_id for device_id, _ in ended])))
            db.commit()
            log.info("Forgot phones whose sign-in ended", extra={"count": len(ended)})
    if not phones:
        return {"sent": 0, "gone": 0}
    data = {
        **(item.get("details") or {}),
        "kind": item["kind"],
        "title": item["title"],
        "body": item["body"],
        "tag": item["tag"],
        "tripId": item["trip_id"],
    }
    if item.get("seq") is not None:
        data["seq"] = str(item["seq"])
    sender = sender_factory(account)
    sent, gone = 0, []
    for device_id, token in phones:
        outcome = sender.send(token, data, left)
        if outcome == "sent":
            sent += 1
        elif outcome == "gone":
            gone.append(device_id)
    if gone:
        with session_scope() as db:
            db.execute(delete(PushDevice).where(PushDevice.device_id.in_(gone)))
            db.commit()
        log.info("Forgot phones Firebase no longer knows", extra={"count": len(gone)})
    return {"sent": sent, "gone": len(gone)}


def _signed_in(now: datetime):
    """The sign-ins still live at `now`: refresh token families with a token that's neither revoked nor expired."""
    return select(RefreshToken.family_id).where(RefreshToken.revoked_at.is_(None), RefreshToken.expires_at > now)


def forget_signed_out(now: datetime | None = None) -> int:
    """Forget the phones whose sign-in has ended (it expired, or was ended without its phone). The scheduler runs
    this every hour, so a phone's token is kept no longer than its sign-in, pushes or not."""
    now = now or datetime.now(UTC)
    live = _signed_in(now)
    with session_scope() as db:
        ended = db.execute(delete(PushDevice).where(PushDevice.family_id.is_not(None), PushDevice.family_id.not_in(live))).rowcount
        # Phones registered before sign-ins were recorded with them: kept while the traveller has any sign-in.
        ended += db.execute(
            delete(PushDevice).where(
                PushDevice.family_id.is_(None),
                ~exists(live.where(RefreshToken.user_id == PushDevice.user_id)),
            )
        ).rowcount
        db.commit()
    if ended:
        log.info("Forgot phones whose sign-in ended", extra={"count": ended})
    return ended


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    announce()
