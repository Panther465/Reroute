"""The expense manager (services/expenses.py): a trip's expenses, typed or from a receipt, kept in step with its
bookings and plan, checked against a budget, and claimed back from the office."""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from typing import Annotated

from app.services.expense_text import ExpenseDraft, merchant_key, parse_expense
from fastapi import APIRouter, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select

from app.adapters import receipts as receipt_reader
from app.clock import now_for
from app.deps import CurrentUser, Db, OwnedTrip
from app.errors import ApiError
from app.models import Expense, ExpenseBudget, ExpenseClaim, ExpenseReceipt
from app.redis_client import get_redis
from app.schemas import (
    ExpenseBookOut,
    ExpenseBudgetIn,
    ExpenseBudgetOut,
    ExpenseClaimIn,
    ExpenseClaimOut,
    ExpenseDraftOut,
    ExpenseIn,
    ExpenseOut,
    ExpensePatch,
    ExpenseTextIn,
    PostBody,
)
from app.services import expenses

router = APIRouter(prefix="/v1/trips/{trip_id}", tags=["expenses"])

#: A receipt's photo, after the phone shrinks it: plenty for a receipt, small for the database.
RECEIPT_MAX_BYTES = 2_000_000
#: Receipts read by Gemini, per traveller per day.
SCANS_PER_DAY = 40
#: What a photo's first bytes must be, whatever its Content-Type says.
_MAGIC = {"image/jpeg": (b"\xff\xd8\xff",), "image/png": (b"\x89PNG\r\n\x1a\n",), "image/webp": (b"RIFF",)}


def _book(db, trip) -> ExpenseBookOut:
    return expenses.book(db, trip, now_for(trip.trip_id), receipt_reader.scanning_available())


def _expense(db, trip, expense_id: str) -> Expense:
    e = db.get(Expense, expense_id)
    if e is None or e.trip_id != trip.trip_id or e.dismissed:
        raise ApiError(404, "Expense not found.")
    return e


def _unlocked(db, e: Expense) -> None:
    if e.claim_id:
        claim = db.get(ExpenseClaim, e.claim_id)
        ref = claim.reference if claim else "a claim"
        raise ApiError(409, f"This expense is in claim {ref}. Withdraw the claim to change it.", code="CLAIMED")


def _one(db, trip, e: Expense) -> ExpenseOut:
    book = _book(db, trip)
    return next(x for x in book.items if x.expense_id == e.expense_id)


def _in_trip(trip, day: date) -> None:
    # A booking can fall a little before or after (a flight the evening before); a typo a year off can't.
    if not (trip.start_date.toordinal() - 30 <= day.toordinal() <= trip.end_date.toordinal() + 30):
        raise ApiError(422, "Choose a day around the trip's dates.", code="VALIDATION_ERROR")


def _draft_out(d: ExpenseDraft) -> ExpenseDraftOut:
    return ExpenseDraftOut(
        title=d.title,
        merchant=d.merchant,
        amount_paise=d.amount_paise,
        tax_paise=d.tax_paise,
        category=d.category,
        payment=d.payment,
        day=d.day,
        gstin=d.gstin,
        source=d.source,
    )


async def _image(request: Request) -> tuple[bytes, str]:
    kind = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if kind not in _MAGIC:
        raise ApiError(415, "Send a photo: JPEG, PNG or WebP.", code="UNSUPPORTED_MEDIA_TYPE")
    data = await request.body()
    if not data:
        raise ApiError(422, "The photo is empty.", code="VALIDATION_ERROR")
    if len(data) > RECEIPT_MAX_BYTES:
        raise ApiError(413, "That photo is too large. Take it again a little further away.", code="PAYLOAD_TOO_LARGE")
    if not data.startswith(_MAGIC[kind]) or (kind == "image/webp" and data[8:12] != b"WEBP"):
        raise ApiError(415, "That file isn't the photo it says it is.", code="UNSUPPORTED_MEDIA_TYPE")
    return data, kind


# ---------- the expenses ----------


@router.get("/expenses", response_model=ExpenseBookOut, response_model_by_alias=True, summary="A trip's expenses, totals, budget, alerts and claims")
def list_expenses(trip: OwnedTrip, db: Db) -> ExpenseBookOut:
    return _book(db, trip)


@router.post("/expenses", response_model=ExpenseOut, response_model_by_alias=True, status_code=201, summary="Add an expense")
def add_expense(body: ExpenseIn, trip: OwnedTrip, db: Db) -> ExpenseOut:
    _in_trip(trip, body.day)
    e = Expense(
        trip_id=trip.trip_id,
        day=body.day,
        category=body.category,
        title=body.title,
        merchant=body.merchant or None,
        note=body.note or None,
        amount_paise=body.amount_paise,
        tax_paise=body.tax_paise,
        gstin=body.gstin,
        payment=body.payment,
        # Paid by the company: there's nothing to claim back.
        reimbursable=body.reimbursable and body.payment != "company",
        source="receipt" if body.from_receipt else "manual",
    )
    db.add(e)
    db.commit()
    return _one(db, trip, e)


@router.patch("/expenses/{expense_id}", response_model=ExpenseOut, response_model_by_alias=True, summary="Change an expense, or confirm an estimate")
def edit_expense(expense_id: str, body: ExpensePatch, trip: OwnedTrip, db: Db) -> ExpenseOut:
    e = _expense(db, trip, expense_id)
    _unlocked(db, e)
    data = body.model_dump(exclude_unset=True)
    confirm = data.pop("confirm", None)
    if "day" in data and data["day"] is not None:
        _in_trip(trip, data["day"])
    for key in ("day", "category", "title", "amount_paise", "payment", "reimbursable"):
        if data.get(key) is not None:
            setattr(e, key, data[key])
    for key in ("merchant", "note", "tax_paise", "gstin"):
        if key in data:
            setattr(e, key, data[key] or None)
    if e.tax_paise is not None and e.tax_paise > e.amount_paise:
        raise ApiError(422, "The GST can't be more than the amount.", code="VALIDATION_ERROR")
    if e.payment == "company":
        e.reimbursable = False
    if data or confirm:
        # A booking or plan expense the traveller touched is theirs now: the trip stops changing it.
        e.edited = e.source in ("booking", "plan") or e.edited
        if confirm or "amount_paise" in data:
            e.estimate = False
    db.commit()
    return _one(db, trip, e)


@router.delete("/expenses/{expense_id}", status_code=204, summary="Remove an expense (one from a booking or the plan is put aside)")
def remove_expense(expense_id: str, trip: OwnedTrip, db: Db) -> Response:
    e = _expense(db, trip, expense_id)
    _unlocked(db, e)
    if e.source in ("booking", "plan"):
        # Kept, hidden, so keeping in step with the trip doesn't bring it back.
        e.dismissed = True
    else:
        db.delete(e)
    db.commit()
    return Response(status_code=204)


@router.post("/expenses/parse", response_model=ExpenseDraftOut, response_model_by_alias=True, summary="Work out an expense from a typed line")
def parse_line(body: ExpenseTextIn, trip: OwnedTrip, user: CurrentUser, db: Db) -> ExpenseDraftOut:
    today = expenses.trip_today(trip, now_for(trip.trip_id))
    return _draft_out(parse_expense(body.text, today, expenses.memory(db, user.user_id)))


# ---------- receipts ----------


@router.post(
    "/expenses/scan",
    response_model=ExpenseDraftOut,
    response_model_by_alias=True,
    summary="Read a receipt's photo into an expense to check (the AI helper with a Gemini key)",
    openapi_extra={"requestBody": {"content": {k: {"schema": {"type": "string", "format": "binary"}} for k in _MAGIC}, "required": True}},
)
async def scan(request: Request, trip: OwnedTrip, user: CurrentUser, db: Db) -> ExpenseDraftOut:
    if not receipt_reader.scanning_available():
        raise ApiError(503, "Reading receipts needs the AI helper. Type the amount instead.", code="SCAN_OFF")
    data, kind = await _image(request)
    today = expenses.trip_today(trip, now_for(trip.trip_id))
    key = f"scan:{user.user_id}:{today.isoformat()}"
    r = get_redis()
    if r.incr(key) == 1:
        r.expire(key, 26 * 3600)
    if int(r.get(key) or 0) > SCANS_PER_DAY:
        raise ApiError(429, "That's a lot of receipts for one day. Type the next ones in.", code="RATE_LIMITED")
    try:
        draft = await receipt_reader.scan_receipt(data, kind, today)
    except receipt_reader.ScanFailed as exc:
        raise ApiError(422, str(exc) or "Couldn't read that receipt. Type it in instead.", code="SCAN_FAILED") from exc
    if draft is None:
        raise ApiError(503, "Reading receipts needs the AI helper. Type the amount instead.", code="SCAN_OFF")
    # The shop's category as the traveller usually files it.
    known = await run_in_threadpool(expenses.memory, db, user.user_id)
    if draft.merchant and merchant_key(draft.merchant) in known:
        category, payment = known[merchant_key(draft.merchant)]
        draft = replace(draft, category=category, payment=draft.payment or payment)
    return _draft_out(draft)


@router.put(
    "/expenses/{expense_id}/receipt",
    status_code=204,
    summary="Keep a receipt's photo with an expense",
    openapi_extra={"requestBody": {"content": {k: {"schema": {"type": "string", "format": "binary"}} for k in _MAGIC}, "required": True}},
)
async def put_receipt(expense_id: str, request: Request, trip: OwnedTrip, db: Db) -> Response:
    data, kind = await _image(request)

    def store() -> None:
        e = _expense(db, trip, expense_id)
        _unlocked(db, e)
        row = db.get(ExpenseReceipt, e.expense_id)
        if row is None:
            db.add(ExpenseReceipt(expense_id=e.expense_id, content_type=kind, data=data, size=len(data)))
        else:
            row.content_type, row.data, row.size = kind, data, len(data)
        db.commit()

    await run_in_threadpool(store)
    return Response(status_code=204)


@router.get("/expenses/{expense_id}/receipt", summary="The receipt's photo", responses={200: {"content": {k: {} for k in _MAGIC}}})
def get_receipt(expense_id: str, trip: OwnedTrip, db: Db) -> Response:
    e = _expense(db, trip, expense_id)
    row = db.get(ExpenseReceipt, e.expense_id)
    if row is None:
        raise ApiError(404, "This expense has no receipt.")
    # Private: never kept by a shared cache, and never run as anything but an image.
    return Response(row.data, media_type=row.content_type, headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


@router.delete("/expenses/{expense_id}/receipt", status_code=204, summary="Remove the receipt's photo")
def delete_receipt(expense_id: str, trip: OwnedTrip, db: Db) -> Response:
    e = _expense(db, trip, expense_id)
    _unlocked(db, e)
    row = db.get(ExpenseReceipt, e.expense_id)
    if row is not None:
        db.delete(row)
        db.commit()
    return Response(status_code=204)


# ---------- the budget ----------


@router.put("/expense-budget", response_model=ExpenseBudgetOut, response_model_by_alias=True, summary="Set the trip's budget and the office's limits")
def set_budget(body: ExpenseBudgetIn, trip: OwnedTrip, db: Db) -> ExpenseBudgetOut:
    budget = db.get(ExpenseBudget, trip.trip_id)
    if budget is None:
        budget = ExpenseBudget(trip_id=trip.trip_id)
        db.add(budget)
    budget.total_paise = body.total_paise or None
    budget.daily_paise = body.daily_paise or None
    budget.category_daily_paise = {k: v for k, v in body.category_daily_paise.items() if v}
    budget.receipt_over_paise = body.receipt_over_paise
    db.commit()
    return _book(db, trip).budget  # type: ignore[return-value]


@router.delete("/expense-budget", status_code=204, summary="Remove the trip's budget")
def remove_budget(trip: OwnedTrip, db: Db) -> Response:
    budget = db.get(ExpenseBudget, trip.trip_id)
    if budget is not None:
        db.delete(budget)
        db.commit()
    return Response(status_code=204)


# ---------- claims and the report ----------


@router.post("/expense-claims", response_model=ExpenseClaimOut, response_model_by_alias=True, status_code=201, summary="Claim expenses back from the office")
def submit_claim(body: ExpenseClaimIn, trip: OwnedTrip, db: Db) -> ExpenseClaimOut:
    claim, count = expenses.submit_claim(db, trip, now_for(trip.trip_id), body.expense_ids)
    return expenses.claim_out(claim, count)


def _count(db, claim: ExpenseClaim) -> int:
    return len(db.scalars(select(Expense.expense_id).where(Expense.claim_id == claim.claim_id)).all())


@router.post("/expense-claims/{claim_id}/reimbursed", response_model=ExpenseClaimOut, response_model_by_alias=True, summary="Mark a claim paid back")
def mark_reimbursed(claim_id: str, body: PostBody, trip: OwnedTrip, db: Db) -> ExpenseClaimOut:
    claim = expenses.own_claim(db, trip, claim_id)
    if claim.status != "reimbursed":
        claim.status = "reimbursed"
        claim.reimbursed_at = now_for(trip.trip_id)
        db.commit()
    return expenses.claim_out(claim, _count(db, claim))


@router.post("/expense-claims/{claim_id}/withdraw", status_code=204, summary="Withdraw a claim not yet paid back, so its expenses can change")
def withdraw_claim(claim_id: str, body: PostBody, trip: OwnedTrip, db: Db) -> Response:
    claim = expenses.own_claim(db, trip, claim_id)
    if claim.status == "reimbursed":
        raise ApiError(409, "This claim was paid back, so it stays.", code="REIMBURSED")
    for e in db.scalars(select(Expense).where(Expense.claim_id == claim.claim_id)):
        e.claim_id = None
    db.delete(claim)
    db.commit()
    return Response(status_code=204)


@router.get(
    "/expenses/export.csv",
    summary="The expenses as a CSV file for the office (one claim's with claimId)",
    responses={200: {"content": {"text/csv": {}}, "description": "UTF-8 with a byte-order mark"}},
)
def export_csv(trip: OwnedTrip, db: Db, claim_id: Annotated[str | None, Query(alias="claimId", max_length=40)] = None) -> Response:
    if claim_id:
        expenses.own_claim(db, trip, claim_id)
    expenses.sync(db, trip)
    name, text = expenses.report_csv(db, trip, claim_id)
    return Response(
        text.encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"},
    )
