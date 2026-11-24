"""The expense manager: what a trip costs, kept in step with its bookings and plan, checked against its budget
and the office's rules, and claimed back.

Amounts are in paise. Expenses come four ways (`Expense.source`):

- manual: added by the traveller, often from a typed line ("Lunch 350 cash") or a receipt's photo (receipt);
- booking: each simulated booking, at what it cost after any refund, paid from the wallet;
- plan: each leg's fare in the day's plan, an estimate until the traveller confirms what they paid.

`sync` brings the last two in line with the trip whenever the expenses are read or changed. One the traveller
changed (`edited`), put aside (`dismissed`) or claimed stays as it is.
"""

from __future__ import annotations

import csv
import io
import secrets
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.clock import tz_for
from app.errors import ApiError
from app.models import Booking, Expense, ExpenseBudget, ExpenseClaim, ExpenseReceipt, Task, Trip
from app.schemas import (
    AmountByOut,
    DayAmountOut,
    ExpenseAlertOut,
    ExpenseBookOut,
    ExpenseBudgetOut,
    ExpenseClaimOut,
    ExpenseOut,
    ExpenseTotalsOut,
)
from app.services.views import _place_names, _plan_for_day

CATEGORY_NAMES = {
    "transport": "Travel",
    "stay": "Stay",
    "food": "Food",
    "tickets": "Tickets",
    "communication": "Phone and internet",
    "office": "Office",
    "client": "Client",
    "other": "Other",
}
PAYMENT_NAMES = {"cash": "Cash", "card": "Card", "upi": "UPI", "wallet": "Reroute wallet", "company": "Paid by company"}
DEFAULT_RECEIPT_OVER = 50000
#: Spent up to this share of the total budget is worth a word.
NEAR_BUDGET = 0.8


def inr(paise: int) -> str:
    """₹1,24,050 or ₹612.50: Indian grouping, paise only when there are some."""
    sign = "-" if paise < 0 else ""
    rupees, rest = divmod(abs(paise), 100)
    digits = str(rupees)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        digits = ",".join([head, *groups, tail]) if head else ",".join([*groups, tail])
    return f"{sign}₹{digits}" + (f".{rest:02d}" if rest else "")


def booking_label(b: Booking) -> str:
    d = b.details
    if b.kind == "flight":
        return f"Flight {d['flightNo']}, {d['originCity']} to {d['destinationCity']}"
    if b.kind == "train":
        return f"Train {d['trainNo']} to {d['destination']}"
    if b.kind == "ticket":
        return f"{d['partner']} tickets to {d['place']}"
    return f"{d['providerLabel']} {d['vehicleLabel'].lower()} ride"


def trip_today(trip: Trip, now: datetime) -> date:
    return now.astimezone(tz_for(trip.utc_offset)).date()


# ---------- keeping bookings and the plan in step ----------


def _booking_day(b: Booking, task_days: dict[str, date], trip: Trip) -> date:
    if b.details.get("date"):
        return date.fromisoformat(b.details["date"])
    if b.to_id and b.to_id in task_days:
        return task_days[b.to_id]
    if b.task_id and b.task_id in task_days:
        return task_days[b.task_id]
    booked = b.created_at.astimezone(tz_for(trip.utc_offset)).date() if b.created_at else trip.start_date
    return min(max(booked, trip.start_date), trip.end_date)


def _wanted(db: Session, trip: Trip) -> dict[str, dict]:
    """The expenses the trip's bookings and plans call for, by their source_ref."""
    wanted: dict[str, dict] = {}
    task_days = {t.task_id: t.day for t in db.scalars(select(Task).where(Task.trip_id == trip.trip_id))}
    # A cab booked for a leg replaces that leg's estimate: (day, the task it goes to, or "end" for the way back).
    covered: set[tuple[date, str]] = set()
    for b in db.scalars(select(Booking).where(Booking.trip_id == trip.trip_id).order_by(Booking.created_at)):
        day = _booking_day(b, task_days, trip)
        if b.kind == "cab" and b.status != "cancelled" and b.to_id:
            covered.add((day, b.to_id))
        refund = int(b.details.get("refundInr", 0)) if b.status == "cancelled" else 0
        net = b.fare_inr - refund
        if net <= 0:
            continue
        title = booking_label(b) + (", cancellation fee" if b.status == "cancelled" else "")
        merchant = b.details.get("providerLabel") or b.details.get("partner") or b.details.get("airline") or b.provider
        wanted[f"booking:{b.booking_id}"] = {
            "day": day,
            "category": "tickets" if b.kind == "ticket" else "transport",
            "title": title[:120],
            "merchant": str(merchant)[:80] if merchant else None,
            "amount_paise": net * 100,
            "payment": "wallet",
            "estimate": False,
            "source": "booking",
        }
    day = trip.start_date
    while day <= trip.end_date:
        plan = _plan_for_day(db, trip.trip_id, day)
        if plan is not None:
            legs = [*(plan.done_legs or []), *plan.legs]
            names = _place_names(db, {x["fromPlaceId"] for x in legs} | {x["toPlaceId"] for x in legs})

            def name(pid: str, names: dict = names) -> str:
                if pid == trip.stay_place_id:
                    return "Hotel"
                p = names.get(pid)
                return p.area if p else "A deleted place"

            seen: dict[str, int] = defaultdict(int)
            for leg in legs:
                fare = int(leg.get("fareInr") or 0)
                if fare <= 0 or (day, leg.get("taskId") or "end") in covered:
                    continue
                base = f"leg:{day}:{leg['fromPlaceId']}>{leg['toPlaceId']}:{leg['mode']}"
                seen[base] += 1
                ref = base if seen[base] == 1 else f"{base}#{seen[base]}"
                wanted[ref] = {
                    "day": day,
                    "category": "transport",
                    "title": f"{name(leg['fromPlaceId'])} to {name(leg['toPlaceId'])}, {leg['label']}"[:120],
                    "merchant": None,
                    "amount_paise": fare * 100,
                    "payment": "cash",
                    "estimate": True,
                    "source": "plan",
                }
        day += timedelta(days=1)
    return wanted


def sync(db: Session, trip: Trip) -> None:
    """Bring the booking and plan expenses in line with the trip. Safe to run at any time, and at once by two requests."""
    # One at a time per trip: the row lock lasts until the commit.
    db.execute(select(Trip.trip_id).where(Trip.trip_id == trip.trip_id).with_for_update())
    existing = {e.source_ref: e for e in db.scalars(select(Expense).where(Expense.trip_id == trip.trip_id, Expense.source_ref.is_not(None)))}
    for ref, fields in _wanted(db, trip).items():
        e = existing.pop(ref, None)
        if e is None:
            db.add(Expense(trip_id=trip.trip_id, source_ref=ref, reimbursable=True, **fields))
        elif not (e.edited or e.dismissed or e.claim_id):
            for key, value in fields.items():
                setattr(e, key, value)
    for e in existing.values():
        # Gone from the trip (re-planned, or a booking refunded in full): unless the traveller made it theirs.
        if e.source in ("plan", "booking") and not (e.edited or e.claim_id):
            db.delete(e)
    db.commit()


# ---------- reading them, with what needs attention ----------


@dataclass
class _Checked:
    flags: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    duplicate_of: dict[str, str] = field(default_factory=dict)
    over_by: dict[str, int] = field(default_factory=dict)
    alerts: list[ExpenseAlertOut] = field(default_factory=list)


def _day_name(day: date) -> str:
    return day.strftime("%a %d %b").replace(" 0", " ")


def _check(items: list[Expense], receipts: set[str], budget: ExpenseBudget | None, today: date, spent: int, forecast: int) -> _Checked:
    out = _Checked()
    threshold = budget.receipt_over_paise if budget else DEFAULT_RECEIPT_OVER

    unconfirmed = [e for e in items if e.estimate and e.day <= today]
    for e in items:
        if e.estimate:
            out.flags[e.expense_id].append("estimate")
    if unconfirmed:
        n = len(unconfirmed)
        out.alerts.append(
            ExpenseAlertOut(
                kind="unconfirmed",
                level="info",
                text=f"Confirm what you paid for {n} {'ride' if n == 1 else 'rides'}: {'it is' if n == 1 else 'they are'} still the plan's estimate.",
                expense_ids=[e.expense_id for e in unconfirmed],
            )
        )

    # Bookings carry their own e-ticket; the plan's estimates aren't claimed until confirmed.
    missing = [
        e
        for e in items
        if e.reimbursable and not e.estimate and e.source in ("manual", "receipt") and e.amount_paise > threshold and e.expense_id not in receipts
    ]
    for e in missing:
        out.flags[e.expense_id].append("needs_receipt")
    if missing:
        n = len(missing)
        out.alerts.append(
            ExpenseAlertOut(
                kind="needs_receipt",
                level="warn",
                text=f"{n} {'expense' if n == 1 else 'expenses'} over {inr(threshold)} {'needs a receipt' if n == 1 else 'need receipts'} for the office.",
                expense_ids=[e.expense_id for e in missing],
            )
        )

    # The same amount, the same day and kind, twice, where the traveller typed at least one in: likely one thing.
    groups: dict[tuple, list[Expense]] = defaultdict(list)
    for e in items:
        if not e.estimate:
            groups[(e.day, e.category, round(e.amount_paise / 100))].append(e)
    for group in groups.values():
        typed = [e for e in group if e.source in ("manual", "receipt")]
        if len(group) < 2 or not typed:
            continue
        first = next((e for e in group if e.source == "booking"), group[0])
        for e in group:
            if e is first:
                continue
            out.flags[e.expense_id].append("possible_duplicate")
            out.duplicate_of[e.expense_id] = first.expense_id
            out.alerts.append(
                ExpenseAlertOut(
                    kind="possible_duplicate",
                    level="warn",
                    text=f"“{e.title}” and “{first.title}” look like the same {inr(e.amount_paise)} on {_day_name(e.day)}. Remove one if so.",
                    expense_ids=[e.expense_id, first.expense_id],
                    day=e.day,
                )
            )

    if budget:
        by_day: dict[date, int] = defaultdict(int)
        by_day_category: dict[tuple[date, str], list[Expense]] = defaultdict(list)
        for e in items:
            by_day[e.day] += e.amount_paise
            by_day_category[(e.day, e.category)].append(e)
        for (day, category), group in sorted(by_day_category.items()):
            limit = (budget.category_daily_paise or {}).get(category)
            total = sum(e.amount_paise for e in group)
            if limit and total > limit:
                for e in group:
                    out.flags[e.expense_id].append("over_limit")
                    out.over_by[e.expense_id] = total - limit
                out.alerts.append(
                    ExpenseAlertOut(
                        kind="over_category",
                        level="warn",
                        text=f"{CATEGORY_NAMES[category]} on {_day_name(day)}: {inr(total)}, {inr(total - limit)} over the {inr(limit)} a day allowed.",
                        expense_ids=[e.expense_id for e in group],
                        day=day,
                    )
                )
        if budget.daily_paise:
            for day, total in sorted(by_day.items()):
                if total > budget.daily_paise:
                    out.alerts.append(
                        ExpenseAlertOut(
                            kind="over_daily",
                            level="warn",
                            text=f"{_day_name(day)}: {inr(total)}, {inr(total - budget.daily_paise)} over your {inr(budget.daily_paise)} a day.",
                            day=day,
                        )
                    )
        if budget.total_paise:
            total = budget.total_paise
            if spent > total:
                out.alerts.insert(
                    0, ExpenseAlertOut(kind="over_budget", level="danger", text=f"Over budget: {inr(spent - total)} more than the {inr(total)} for this trip.")
                )
            elif forecast > total:
                out.alerts.insert(
                    0,
                    ExpenseAlertOut(
                        kind="heading_over",
                        level="warn",
                        text=f"Heading over budget: at this pace the trip costs about {inr(forecast)}, {inr(forecast - total)} more than the {inr(total)}.",
                    ),
                )
            elif spent >= NEAR_BUDGET * total:
                out.alerts.insert(0, ExpenseAlertOut(kind="near_budget", level="info", text=f"{inr(total - spent)} left of the {inr(total)} budget."))
    return out


def _totals(trip: Trip, items: list[Expense], claims: dict[str, ExpenseClaim], today: date) -> ExpenseTotalsOut:
    spent = sum(e.amount_paise for e in items if e.day <= today)
    upcoming = sum(e.amount_paise for e in items if e.day > today)
    # What the plan and bookings don't foresee (food, stay, the rest): its daily pace so far, for the days left.
    elapsed = max(1, (min(today, trip.end_date) - trip.start_date).days + 1) if today >= trip.start_date else 0
    own = sum(e.amount_paise for e in items if e.source in ("manual", "receipt") and e.day <= today)
    pace = own // elapsed if elapsed else 0
    days_left = max(0, (trip.end_date - max(today, trip.start_date - timedelta(days=1))).days) if today < trip.end_date else 0
    forecast = spent + upcoming + pace * days_left
    to_claim = claimed = reimbursed = owed = 0
    for e in items:
        if not e.reimbursable or e.estimate:
            continue
        status = claims[e.claim_id].status if e.claim_id in claims else None
        if status is None and e.day <= today:
            to_claim += e.amount_paise
        elif status == "submitted":
            claimed += e.amount_paise
        elif status == "reimbursed":
            reimbursed += e.amount_paise
        if e.payment != "company" and status != "reimbursed":
            owed += e.amount_paise

    def by(key) -> list[AmountByOut]:
        sums: dict[str, int] = defaultdict(int)
        for e in items:
            sums[key(e)] += e.amount_paise
        return [AmountByOut(key=k, paise=v) for k, v in sorted(sums.items(), key=lambda kv: -kv[1])]

    days: dict[date, int] = defaultdict(int)
    for e in items:
        days[e.day] += e.amount_paise
    return ExpenseTotalsOut(
        today=today,
        spent_paise=spent,
        estimated_paise=sum(e.amount_paise for e in items if e.estimate and e.day <= today),
        upcoming_paise=upcoming,
        forecast_paise=forecast,
        pace_daily_paise=pace,
        to_claim_paise=to_claim,
        claimed_paise=claimed,
        reimbursed_paise=reimbursed,
        owed_to_you_paise=owed,
        by_category=by(lambda e: e.category),
        by_payment=by(lambda e: e.payment),
        by_day=[DayAmountOut(day=d, paise=v) for d, v in sorted(days.items())],
    )


def _insights(totals: ExpenseTotalsOut, items: list[Expense]) -> list[str]:
    out: list[str] = []
    total = sum(x.paise for x in totals.by_category)
    if total and totals.by_category:
        top = totals.by_category[0]
        share = round(100 * top.paise / total)
        if len(totals.by_category) > 1:
            out.append(f"{CATEGORY_NAMES[top.key]} is the biggest cost: {share}% ({inr(top.paise)}).")
    if totals.pace_daily_paise:
        out.append(f"You spend about {inr(totals.pace_daily_paise)} a day on top of travel and bookings.")
    if totals.owed_to_you_paise:
        out.append(f"The office owes you {inr(totals.owed_to_you_paise)} once it pays back what you paid yourself.")
    cash = sum(e.amount_paise for e in items if e.payment == "cash" and not e.estimate)
    if cash and total and cash / total > 0.4:
        out.append(f"{round(100 * cash / total)}% was paid in cash: ask for a receipt each time, the office may need one.")
    return out


def claim_out(c: ExpenseClaim, count: int) -> ExpenseClaimOut:
    return ExpenseClaimOut(
        claim_id=c.claim_id,
        reference=c.reference,
        status=c.status,
        total_paise=c.total_paise,
        count=count,
        submitted_at=c.submitted_at,
        reimbursed_at=c.reimbursed_at,
    )


def expense_out(e: Expense, receipts: set[str], claims: dict[str, ExpenseClaim], checked: _Checked | None = None) -> ExpenseOut:
    return ExpenseOut(
        expense_id=e.expense_id,
        day=e.day,
        category=e.category,
        title=e.title,
        merchant=e.merchant,
        note=e.note,
        amount_paise=e.amount_paise,
        tax_paise=e.tax_paise,
        gstin=e.gstin,
        payment=e.payment,
        reimbursable=e.reimbursable,
        source=e.source,
        estimate=e.estimate,
        edited=e.edited,
        has_receipt=e.expense_id in receipts,
        claim_id=e.claim_id,
        claim_status=claims[e.claim_id].status if e.claim_id in claims else None,
        flags=sorted(set(checked.flags.get(e.expense_id, []))) if checked else [],
        duplicate_of=checked.duplicate_of.get(e.expense_id) if checked else None,
        over_by_paise=checked.over_by.get(e.expense_id) if checked else None,
    )


def _visible(db: Session, trip: Trip) -> list[Expense]:
    stmt = select(Expense).where(Expense.trip_id == trip.trip_id, Expense.dismissed.is_(False)).order_by(Expense.day.desc(), Expense.created_at.desc())
    return list(db.scalars(stmt))


def _receipts(db: Session, ids: list[str]) -> set[str]:
    return set(db.scalars(select(ExpenseReceipt.expense_id).where(ExpenseReceipt.expense_id.in_(ids)))) if ids else set()


def _claims(db: Session, trip: Trip) -> dict[str, ExpenseClaim]:
    return {c.claim_id: c for c in db.scalars(select(ExpenseClaim).where(ExpenseClaim.trip_id == trip.trip_id))}


def budget_out(budget: ExpenseBudget | None, spent: int, forecast: int) -> ExpenseBudgetOut | None:
    if budget is None:
        return None
    total = budget.total_paise
    return ExpenseBudgetOut(
        total_paise=total,
        daily_paise=budget.daily_paise,
        category_daily_paise=budget.category_daily_paise or {},
        receipt_over_paise=budget.receipt_over_paise,
        left_paise=total - forecast if total else None,
        used_percent=round(100 * spent / total) if total else None,
    )


def book(db: Session, trip: Trip, now: datetime, scanning: bool) -> ExpenseBookOut:
    sync(db, trip)
    items = _visible(db, trip)
    receipts = _receipts(db, [e.expense_id for e in items])
    claims = _claims(db, trip)
    budget = db.get(ExpenseBudget, trip.trip_id)
    today = trip_today(trip, now)
    totals = _totals(trip, items, claims, today)
    checked = _check(items, receipts, budget, today, totals.spent_paise, totals.forecast_paise)
    counts: dict[str, int] = defaultdict(int)
    for e in items:
        if e.claim_id:
            counts[e.claim_id] += 1
    return ExpenseBookOut(
        trip_id=trip.trip_id,
        city_name=trip.city_name,
        items=[expense_out(e, receipts, claims, checked) for e in items],
        totals=totals,
        budget=budget_out(budget, totals.spent_paise, totals.forecast_paise),
        alerts=checked.alerts,
        insights=_insights(totals, items),
        claims=[claim_out(c, counts[c.claim_id]) for c in sorted(claims.values(), key=lambda c: c.submitted_at, reverse=True)],
        scanning=scanning,
    )


# ---------- what the traveller has taught it ----------


def memory(db: Session, user_id: str) -> dict[str, tuple[str, str | None]]:
    """Each shop's category and payment, as the traveller last recorded them, across their trips."""
    from app.services.expense_text import merchant_key

    rows = db.execute(
        select(Expense.merchant, Expense.category, Expense.payment)
        .join(Trip, Trip.trip_id == Expense.trip_id)
        .where(Trip.user_id == user_id, Expense.merchant.is_not(None), Expense.source.in_(("manual", "receipt")))
        .order_by(Expense.updated_at.desc())
        .limit(500)
    )
    out: dict[str, tuple[str, str | None]] = {}
    for merchant, category, payment in rows:
        out.setdefault(merchant_key(merchant), (category, payment))
    return out


# ---------- claims ----------


def _reference() -> str:
    alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    return "RR-" + "".join(secrets.choice(alphabet) for _ in range(6))


def submit_claim(db: Session, trip: Trip, now: datetime, ids: list[str] | None) -> tuple[ExpenseClaim, int]:
    sync(db, trip)
    today = trip_today(trip, now)
    ready = select(Expense).where(
        Expense.trip_id == trip.trip_id,
        Expense.dismissed.is_(False),
        Expense.reimbursable.is_(True),
        Expense.estimate.is_(False),
        Expense.claim_id.is_(None),
        Expense.day <= today,
    )
    if ids is not None:
        ready = ready.where(Expense.expense_id.in_(ids))
    items = list(db.scalars(ready.with_for_update()))
    if not items:
        raise ApiError(409, "Nothing is ready to claim: add expenses, confirm the plan's estimates, or check they're reimbursable.", code="NOTHING_TO_CLAIM")
    claim = ExpenseClaim(
        trip_id=trip.trip_id, reference=_reference(), status="submitted", total_paise=sum(e.amount_paise for e in items), submitted_at=now.astimezone(UTC)
    )
    db.add(claim)
    db.flush()
    for e in items:
        e.claim_id = claim.claim_id
    db.commit()
    return claim, len(items)


def own_claim(db: Session, trip: Trip, claim_id: str) -> ExpenseClaim:
    claim = db.get(ExpenseClaim, claim_id)
    if claim is None or claim.trip_id != trip.trip_id:
        raise ApiError(404, "Claim not found.")
    return claim


# ---------- the report ----------

CSV_COLUMNS = [
    "Date",
    "Category",
    "Description",
    "Merchant",
    "Payment",
    "Reimbursable",
    "Amount (INR)",
    "GST (INR)",
    "GSTIN",
    "Receipt",
    "Estimate",
    "Claim",
    "Claim status",
    "Note",
]


def _cell(value: object) -> str:
    """A spreadsheet never runs a cell as a formula: one starting = + - @ is kept as text (OWASP CSV injection)."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def report_csv(db: Session, trip: Trip, claim_id: str | None = None) -> tuple[str, str]:
    """The trip's expenses (or one claim's) as CSV for the office's spreadsheet or finance system: name and text."""
    items = [e for e in _visible(db, trip) if claim_id is None or e.claim_id == claim_id]
    items.sort(key=lambda e: (e.day, e.created_at or datetime.min.replace(tzinfo=UTC)))
    receipts = _receipts(db, [e.expense_id for e in items])
    claims = _claims(db, trip)
    buf = io.StringIO()
    out = csv.writer(buf, lineterminator="\r\n")
    out.writerow(CSV_COLUMNS)
    for e in items:
        claim = claims.get(e.claim_id) if e.claim_id else None
        out.writerow(
            [
                _cell(x)
                for x in (
                    e.day.isoformat(),
                    CATEGORY_NAMES[e.category],
                    e.title,
                    e.merchant,
                    PAYMENT_NAMES[e.payment],
                    "Yes" if e.reimbursable else "No",
                    f"{e.amount_paise / 100:.2f}",
                    f"{e.tax_paise / 100:.2f}" if e.tax_paise is not None else "",
                    e.gstin,
                    "Yes" if e.expense_id in receipts else "No",
                    "Yes" if e.estimate else "No",
                    claim.reference if claim else "",
                    claim.status if claim else "",
                    e.note,
                )
            ]
        )
    total = sum(e.amount_paise for e in items)
    out.writerow(["", "", "Total", "", "", "", f"{total / 100:.2f}", "", "", "", "", "", "", ""])
    ref = claims[claim_id].reference if claim_id and claim_id in claims else trip.city_name.lower().replace(" ", "-")
    # A byte-order mark, so a spreadsheet opens ₹ and Hindi names as UTF-8.
    return f"reroute-expenses-{ref}.csv", "﻿" + buf.getvalue()
