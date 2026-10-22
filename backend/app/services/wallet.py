"""The wallet: simulated money that pays for simulated bookings. Nothing real is charged.

The balance is the sum of the entries (money in is positive, a booking negative), so every change has
a line the traveller can read, and a booking and its charge commit together.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import ApiError
from app.models import User, WalletEntry

#: A new account starts with this much simulated money; the demo accounts with more.
WELCOME_INR = 2000
DEMO_INR = 5000


def balance(db: Session, user_id: str) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(WalletEntry.amount_inr), 0)).where(WalletEntry.user_id == user_id)) or 0)


def entries(db: Session, user_id: str, limit: int = 50) -> list[WalletEntry]:
    newest = (WalletEntry.created_at.desc(), WalletEntry.entry_id.desc())
    return list(db.scalars(select(WalletEntry).where(WalletEntry.user_id == user_id).order_by(*newest).limit(limit)))


def _add(db: Session, user_id: str, amount: int, kind: str, label: str, booking_id: str | None = None) -> WalletEntry:
    entry = WalletEntry(user_id=user_id, amount_inr=amount, kind=kind, label=label, booking_id=booking_id)
    db.add(entry)
    db.flush()
    return entry


def credit_welcome(db: Session, user_id: str, amount: int = WELCOME_INR) -> None:
    """The welcome credit, once per account."""
    if db.scalar(select(WalletEntry.entry_id).where(WalletEntry.user_id == user_id, WalletEntry.kind == "welcome").limit(1)) is None:
        _add(db, user_id, amount, "welcome", "Welcome to Reroute (simulated money)")


def top_up(db: Session, user_id: str, amount: int) -> WalletEntry:
    return _add(db, user_id, amount, "topup", "Added money (simulated)")


def charge(db: Session, user_id: str, amount: int, label: str, booking_id: str) -> WalletEntry:
    """Pay for a booking. Not enough money: 409, with how much more is needed; nothing is written."""
    # Lock the traveller so two bookings at once can't both spend the same money.
    db.execute(select(User.user_id).where(User.user_id == user_id).with_for_update())
    have = balance(db, user_id)
    if have < amount:
        raise ApiError(409, f"Not enough in your wallet: add ₹{amount - have:,} to book this.", code="INSUFFICIENT_FUNDS")
    return _add(db, user_id, -amount, "booking", label, booking_id)


def refund(db: Session, user_id: str, amount: int, label: str, booking_id: str) -> None:
    if amount > 0:
        _add(db, user_id, amount, "refund", label, booking_id)


def reset(db: Session, user_id: str, amount: int = DEMO_INR) -> None:
    """The demo account's wallet back to its starting balance (the demo reset)."""
    db.query(WalletEntry).filter(WalletEntry.user_id == user_id).delete()
    _add(db, user_id, amount, "welcome", "Demo balance (simulated money)")
