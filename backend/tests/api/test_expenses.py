"""The expense manager: expenses by hand, from a typed line or a receipt, kept in step with bookings and the plan,
checked against a budget and the office's rules, claimed back, and exported for the office."""

from __future__ import annotations

import csv
import io
from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from app.adapters import receipts as receipt_reader
from app.routes import expenses as expense_routes
from app.services import expenses as expense_service
from app.services.expense_text import ExpenseDraft

from .conftest import key
from .test_flow import plan_v1
from .test_own_places import sign_up

IST = timezone(timedelta(hours=5, minutes=30))
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 200
TRIP = {
    "citySlug": "bengaluru",
    "cityName": "Bengaluru",
    "startDate": "2030-01-15",
    "endDate": "2030-01-17",
    "stayPlaceId": "hotel-majestic",
    "stayLabel": "Hotel",
}


@pytest.fixture
def mid_trip(monkeypatch):
    """The trip's clock at noon on its second day (15 to 17 January 2030)."""
    monkeypatch.setattr(expense_routes, "now_for", lambda trip_id=None: datetime(2030, 1, 16, 12, 0, tzinfo=IST))


def new_trip(client, headers) -> str:
    res = client.post("/v1/trips", json={**TRIP, "idempotencyKey": key()}, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()["tripId"]


def add(client, trip_id, headers=None, **body) -> dict:
    payload = {"day": "2030-01-16", "category": "food", "title": "Lunch", "amountPaise": 35000, "payment": "cash", **body}
    res = client.post(f"/v1/trips/{trip_id}/expenses", json={**payload, "idempotencyKey": key()}, headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


def book(client, trip_id, headers=None) -> dict:
    res = client.get(f"/v1/trips/{trip_id}/expenses", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


# ---------- from bookings and the plan ----------


@pytest.mark.db
def test_the_plans_fares_come_in_as_estimates_and_a_booked_cab_replaces_its_legs(client):
    plan = plan_v1(client)
    paid_legs = [leg for leg in plan["legs"] if leg["fareInr"] > 0]
    items = book(client, "trip-001")["items"]
    estimates = [e for e in items if e["source"] == "plan"]
    assert len(estimates) == len(paid_legs) and all(e["estimate"] and "estimate" in e["flags"] for e in estimates)
    assert sum(e["amountPaise"] for e in estimates) == 100 * sum(leg["fareInr"] for leg in paid_legs)
    assert all(e["category"] == "transport" and " to " in e["title"] for e in estimates)
    # Reading again changes nothing.
    assert [e["expenseId"] for e in book(client, "trip-001")["items"]] == [e["expenseId"] for e in items]

    options = client.get("/v1/trips/trip-001/cab-options", params={"toId": "task-bank"}).json()
    ride = client.post(
        "/v1/trips/trip-001/bookings", json={"kind": "cab", "toId": "task-bank", "optionId": options[0]["optionId"], "idempotencyKey": key()}
    ).json()
    items = book(client, "trip-001")["items"]
    booked = [e for e in items if e["source"] == "booking"]
    assert [(e["amountPaise"], e["payment"], e["estimate"], e["category"]) for e in booked] == [(ride["fareInr"] * 100, "wallet", False, "transport")]
    bank_leg = next(leg for leg in plan["legs"] if leg.get("taskId") == "task-bank")
    assert len([e for e in items if e["source"] == "plan"]) == len(paid_legs) - (1 if bank_leg["fareInr"] > 0 else 0)

    # Cancelled before pickup, refunded in full: the booking goes, and the leg's estimate is back.
    client.post(f"/v1/trips/trip-001/bookings/{ride['bookingId']}/cancel", json={"idempotencyKey": key()})
    items = book(client, "trip-001")["items"]
    assert not [e for e in items if e["source"] == "booking"]
    assert len([e for e in items if e["source"] == "plan"]) == len(paid_legs)


@pytest.mark.db
def test_a_cancelled_train_leaves_its_fee(client):
    from app.db import session_scope
    from app.models import Booking

    with session_scope() as db:
        db.add(
            Booking(
                booking_id="bkg-train1",
                trip_id="trip-001",
                kind="train",
                provider="railgo",
                reference="PNR1",
                fare_inr=900,
                status="cancelled",
                details={"trainNo": "12008", "destination": "Mysuru", "date": "2026-10-15", "refundInr": 840, "passengers": [{}]},
            )
        )
    [fee] = [e for e in book(client, "trip-001")["items"] if e["source"] == "booking"]
    assert (fee["amountPaise"], fee["title"], fee["day"]) == (6000, "Train 12008 to Mysuru, cancellation fee", "2026-10-15")


@pytest.mark.db
def test_confirming_or_changing_an_estimate_makes_it_yours_and_removing_one_puts_it_aside(client):
    plan_v1(client)
    estimates = [e for e in book(client, "trip-001")["items"] if e["source"] == "plan"]
    first, second = estimates[0], estimates[1]

    res = client.patch(f"/v1/trips/trip-001/expenses/{first['expenseId']}", json={"confirm": True})
    assert res.status_code == 200 and res.json()["estimate"] is False and res.json()["edited"] is True
    res = client.patch(f"/v1/trips/trip-001/expenses/{second['expenseId']}", json={"amountPaise": 12345, "payment": "upi"})
    assert (res.json()["amountPaise"], res.json()["payment"], res.json()["estimate"]) == (12345, "upi", False)

    third = estimates[2] if len(estimates) > 2 else None
    if third:
        assert client.delete(f"/v1/trips/trip-001/expenses/{third['expenseId']}").status_code == 204
    after = {e["expenseId"]: e for e in book(client, "trip-001")["items"]}
    assert after[second["expenseId"]]["amountPaise"] == 12345
    if third:
        assert third["expenseId"] not in after
        assert client.patch(f"/v1/trips/trip-001/expenses/{third['expenseId']}", json={"confirm": True}).status_code == 404


# ---------- by hand ----------


@pytest.mark.db
def test_adding_changing_and_removing_by_hand(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    lunch = add(client, trip, asha, title="Lunch at Truffles", merchant="Truffles", amountPaise=61250, taxPaise=2916, gstin="29abcde1234f1z5")
    assert (lunch["source"], lunch["gstin"], lunch["reimbursable"], lunch["flags"]) == ("manual", "29ABCDE1234F1Z5", True, ["needs_receipt"])
    company = add(client, trip, asha, title="Hotel", category="stay", payment="company", amountPaise=450000)
    assert company["reimbursable"] is False

    bad = client.post(
        f"/v1/trips/{trip}/expenses",
        json={"day": "2030-01-16", "category": "food", "title": "x", "amountPaise": 100, "taxPaise": 200, "idempotencyKey": key()},
        headers=asha,
    )
    assert bad.status_code == 422
    far = client.post(
        f"/v1/trips/{trip}/expenses", json={"day": "2031-01-16", "category": "food", "title": "x", "amountPaise": 100, "idempotencyKey": key()}, headers=asha
    )
    assert far.status_code == 422
    assert (
        client.post(
            f"/v1/trips/{trip}/expenses",
            json={"day": "2030-01-16", "category": "petrol", "title": "x", "amountPaise": 100, "idempotencyKey": key()},
            headers=asha,
        ).status_code
        == 422
    )

    res = client.patch(f"/v1/trips/{trip}/expenses/{lunch['expenseId']}", json={"category": "client", "note": "With the Acme team"}, headers=asha)
    assert (res.json()["category"], res.json()["note"]) == ("client", "With the Acme team")
    assert client.delete(f"/v1/trips/{trip}/expenses/{lunch['expenseId']}", headers=asha).status_code == 204
    assert [e["title"] for e in book(client, trip, asha)["items"]] == ["Hotel"]
    # Nobody else's.
    assert client.get(f"/v1/trips/{trip}/expenses").status_code == 404


@pytest.mark.db
def test_totals_forecast_the_trip_and_say_what_is_owed(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    add(client, trip, asha, day="2030-01-15", amountPaise=40000)
    add(client, trip, asha, day="2030-01-16", amountPaise=60000, payment="card")
    add(client, trip, asha, day="2030-01-17", category="stay", title="Hotel", amountPaise=300000, payment="company")
    t = book(client, trip, asha)["totals"]
    assert t["today"] == "2030-01-16"
    assert (t["spentPaise"], t["upcomingPaise"]) == (100000, 300000)
    # ₹1,000 of their own over two days is ₹500 a day, for the one day left.
    assert (t["paceDailyPaise"], t["forecastPaise"]) == (50000, 100000 + 300000 + 50000)
    assert (t["toClaimPaise"], t["owedToYouPaise"]) == (100000, 100000)
    assert [(x["key"], x["paise"]) for x in t["byCategory"]] == [("stay", 300000), ("food", 100000)]
    assert [d["day"] for d in t["byDay"]] == ["2030-01-15", "2030-01-16", "2030-01-17"]
    insights = book(client, trip, asha)["insights"]
    assert any("Stay is the biggest cost" in i for i in insights) and any("owes you ₹1,000" in i for i in insights)


# ---------- the budget and the office's rules ----------


@pytest.mark.db
def test_the_budget_and_limits_flag_what_goes_over(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    a = add(client, trip, asha, title="Breakfast", amountPaise=30000)
    b = add(client, trip, asha, title="Dinner", amountPaise=65000)
    res = client.put(f"/v1/trips/{trip}/expense-budget", json={"totalPaise": 100000, "dailyPaise": 90000, "categoryDailyPaise": {"food": 80000}}, headers=asha)
    assert res.status_code == 200, res.text
    assert (res.json()["usedPercent"], res.json()["receiptOverPaise"]) == (95, 50000)
    data = book(client, trip, asha)
    kinds = [a_["kind"] for a_ in data["alerts"]]
    # ₹950 spent of ₹1,000, and the pace says the last day goes over.
    assert kinds[0] == "heading_over" and "over_category" in kinds and "over_daily" in kinds
    flagged = {e["expenseId"]: e for e in data["items"]}
    assert "over_limit" in flagged[a["expenseId"]]["flags"] and flagged[b["expenseId"]]["overByPaise"] == 15000
    over = next(x for x in data["alerts"] if x["kind"] == "over_category")
    assert over["text"] == "Food on Wed 16 Jan: ₹950, ₹150 over the ₹800 a day allowed."

    add(client, trip, asha, title="Snacks", amountPaise=10000)
    assert book(client, trip, asha)["alerts"][0]["kind"] == "over_budget"
    assert client.delete(f"/v1/trips/{trip}/expense-budget", headers=asha).status_code == 204
    assert book(client, trip, asha)["budget"] is None


@pytest.mark.db
def test_a_typed_expense_that_matches_a_booking_looks_like_a_duplicate(client):
    plan_v1(client)
    options = client.get("/v1/trips/trip-001/cab-options", params={"toId": "task-bank"}).json()
    ride = client.post(
        "/v1/trips/trip-001/bookings", json={"kind": "cab", "toId": "task-bank", "optionId": options[0]["optionId"], "idempotencyKey": key()}
    ).json()
    booked = next(e for e in book(client, "trip-001")["items"] if e["source"] == "booking")
    typed = add(client, "trip-001", day=booked["day"], category="transport", title="Cab to the bank", amountPaise=ride["fareInr"] * 100)
    data = book(client, "trip-001")
    mine = next(e for e in data["items"] if e["expenseId"] == typed["expenseId"])
    assert "possible_duplicate" in mine["flags"] and mine["duplicateOf"] == booked["expenseId"]
    assert any(a["kind"] == "possible_duplicate" for a in data["alerts"])


# ---------- receipts ----------


@pytest.mark.db
def test_a_receipt_photo_is_kept_checked_and_clears_the_flag(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    e = add(client, trip, asha, amountPaise=60000)
    url = f"/v1/trips/{trip}/expenses/{e['expenseId']}/receipt"
    assert client.put(url, content=b"not an image", headers={**asha, "Content-Type": "image/jpeg"}).status_code == 415
    assert client.put(url, content=JPEG, headers={**asha, "Content-Type": "application/pdf"}).status_code == 415
    too_big = client.put(url, content=JPEG + b"\x00" * 2_200_000, headers={**asha, "Content-Type": "image/jpeg"})
    assert too_big.status_code == 413
    assert client.put(url, content=JPEG, headers={**asha, "Content-Type": "image/jpeg"}).status_code == 204
    got = client.get(url, headers=asha)
    assert got.status_code == 200 and got.content == JPEG and got.headers["content-type"] == "image/jpeg" and got.headers["cache-control"].startswith("private")
    mine = book(client, trip, asha)["items"][0]
    assert mine["hasReceipt"] is True and "needs_receipt" not in mine["flags"]
    assert client.get(url).status_code == 404  # nobody else's
    assert client.delete(url, headers=asha).status_code == 204
    assert book(client, trip, asha)["items"][0]["hasReceipt"] is False


@pytest.mark.db
def test_reading_a_receipt_needs_the_ai_helper_and_files_it_as_the_traveller_does(client, monkeypatch, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    scan = f"/v1/trips/{trip}/expenses/scan"
    off = client.post(scan, content=JPEG, headers={**asha, "Content-Type": "image/jpeg"})
    assert off.status_code == 503 and off.json()["error"]["code"] == "SCAN_OFF"

    async def read(image, content_type, today, client=None):
        assert image == JPEG and content_type == "image/jpeg" and today == date(2030, 1, 16)
        return ExpenseDraft(
            title="Toit",
            amount_paise=320000,
            tax_paise=None,
            category="food",
            payment=None,
            day=date(2030, 1, 15),
            gstin=None,
            merchant="Toit",
            source="receipt",
        )

    monkeypatch.setattr(receipt_reader, "scanning_available", lambda: True)
    monkeypatch.setattr(receipt_reader, "scan_receipt", read)
    assert book(client, trip, asha)["scanning"] is True
    res = client.post(scan, content=JPEG, headers={**asha, "Content-Type": "image/jpeg"})
    assert res.status_code == 200, res.text
    assert (res.json()["amountPaise"], res.json()["category"], res.json()["source"]) == (320000, "food", "receipt")
    # Asha files Toit as client entertainment, paid by card: the next receipt from there follows suit.
    add(client, trip, asha, title="Client dinner", merchant="Toit", category="client", payment="card", amountPaise=210000, fromReceipt=True)
    again = client.post(scan, content=JPEG, headers={**asha, "Content-Type": "image/jpeg"}).json()
    assert (again["category"], again["payment"]) == ("client", "card")

    async def unreadable(*a, **k):
        raise receipt_reader.ScanFailed("Couldn't read a total on that receipt.")

    monkeypatch.setattr(receipt_reader, "scan_receipt", unreadable)
    bad = client.post(scan, content=JPEG, headers={**asha, "Content-Type": "image/jpeg"})
    assert bad.status_code == 422 and bad.json()["error"]["message"] == "Couldn't read a total on that receipt."


@pytest.mark.db
def test_a_typed_line_becomes_a_draft_using_what_the_traveller_taught_it(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    url = f"/v1/trips/{trip}/expenses/parse"
    draft = client.post(url, json={"text": "Lunch 350 cash at Truffles", "idempotencyKey": key()}, headers=asha).json()
    assert (draft["amountPaise"], draft["category"], draft["payment"], draft["source"]) == (35000, "food", "cash", "text")
    add(client, trip, asha, title="Dinner", merchant="Toit", category="client", payment="card", amountPaise=200000)
    taught = client.post(url, json={"text": "Toit 1800", "idempotencyKey": key()}, headers=asha).json()
    assert (taught["amountPaise"], taught["category"], taught["payment"]) == (180000, "client", "card")


# ---------- claims and the report ----------


@pytest.mark.db
def test_claiming_locks_the_expenses_until_withdrawn_and_marks_them_paid_back(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    lunch = add(client, trip, asha, amountPaise=35000)
    add(client, trip, asha, day="2030-01-15", title="Auto", category="transport", amountPaise=8000)
    add(client, trip, asha, day="2030-01-17", title="Tomorrow's dinner", amountPaise=50000)
    add(client, trip, asha, title="Personal", amountPaise=20000, reimbursable=False)

    res = client.post(f"/v1/trips/{trip}/expense-claims", json={"idempotencyKey": key()}, headers=asha)
    assert res.status_code == 201, res.text
    claim = res.json()
    # Only what's reimbursable and up to today.
    assert (claim["count"], claim["totalPaise"], claim["status"]) == (2, 43000, "submitted") and claim["reference"].startswith("RR-")
    locked = client.patch(f"/v1/trips/{trip}/expenses/{lunch['expenseId']}", json={"amountPaise": 1}, headers=asha)
    assert locked.status_code == 409 and claim["reference"] in locked.json()["error"]["message"]
    assert client.delete(f"/v1/trips/{trip}/expenses/{lunch['expenseId']}", headers=asha).status_code == 409
    again = client.post(f"/v1/trips/{trip}/expense-claims", json={"idempotencyKey": key()}, headers=asha)
    assert again.status_code == 409 and again.json()["error"]["code"] == "NOTHING_TO_CLAIM"
    totals = book(client, trip, asha)["totals"]
    assert (totals["claimedPaise"], totals["toClaimPaise"]) == (43000, 0)

    assert client.post(f"/v1/trips/{trip}/expense-claims/{claim['claimId']}/withdraw", json={"idempotencyKey": key()}, headers=asha).status_code == 204
    assert client.patch(f"/v1/trips/{trip}/expenses/{lunch['expenseId']}", json={"amountPaise": 36000}, headers=asha).status_code == 200

    claim = client.post(f"/v1/trips/{trip}/expense-claims", json={"expenseIds": [lunch["expenseId"]], "idempotencyKey": key()}, headers=asha).json()
    assert (claim["count"], claim["totalPaise"]) == (1, 36000)
    paid = client.post(f"/v1/trips/{trip}/expense-claims/{claim['claimId']}/reimbursed", json={"idempotencyKey": key()}, headers=asha).json()
    assert paid["status"] == "reimbursed" and paid["reimbursedAt"]
    assert client.post(f"/v1/trips/{trip}/expense-claims/{claim['claimId']}/withdraw", json={"idempotencyKey": key()}, headers=asha).status_code == 409
    data = book(client, trip, asha)
    assert data["totals"]["reimbursedPaise"] == 36000 and data["claims"][0]["status"] == "reimbursed"
    assert next(e for e in data["items"] if e["expenseId"] == lunch["expenseId"])["claimStatus"] == "reimbursed"


@pytest.mark.db
def test_the_estimates_wait_to_be_confirmed_before_a_claim(client):
    plan_v1(client)
    res = client.post("/v1/trips/trip-001/expense-claims", json={"idempotencyKey": key()})
    assert res.status_code == 409


@pytest.mark.db
def test_the_csv_report_opens_in_a_spreadsheet_and_never_runs_a_formula(client, mid_trip):
    asha = sign_up(client, "Asha")
    trip = new_trip(client, asha)
    add(client, trip, asha, title='=HYPERLINK("http://evil")', amountPaise=61250, taxPaise=2916, gstin="29ABCDE1234F1Z5")
    add(client, trip, asha, day="2030-01-15", title="Auto", category="transport", amountPaise=8000, payment="upi")
    res = client.get(f"/v1/trips/{trip}/expenses/export.csv", headers=asha)
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/csv")
    assert res.headers["content-disposition"] == 'attachment; filename="reroute-expenses-bengaluru.csv"'
    text = res.content.decode("utf-8")
    assert text.startswith("﻿")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    assert rows[0][:7] == ["Date", "Category", "Description", "Merchant", "Payment", "Reimbursable", "Amount (INR)"]
    assert rows[1][:7] == ["2030-01-15", "Travel", "Auto", "", "UPI", "Yes", "80.00"]
    assert rows[2][2] == '\'=HYPERLINK("http://evil")' and rows[2][7:9] == ["29.16", "29ABCDE1234F1Z5"]
    assert rows[-1][2:7] == ["Total", "", "", "", "692.50"]
    claim = client.post(f"/v1/trips/{trip}/expense-claims", json={"idempotencyKey": key()}, headers=asha).json()
    one = client.get(f"/v1/trips/{trip}/expenses/export.csv", params={"claimId": claim["claimId"]}, headers=asha)
    assert claim["reference"] in one.headers["content-disposition"]
    assert client.get(f"/v1/trips/{trip}/expenses/export.csv", params={"claimId": "clm-nope"}, headers=asha).status_code == 404


@pytest.mark.db
def test_a_demo_reset_clears_the_demo_trips_expenses(client):
    add(client, "trip-001", day="2026-10-14")
    client.put("/v1/trips/trip-001/expense-budget", json={"totalPaise": 100000})
    client.post("/v1/trips/trip-001/demo/reset", json={"idempotencyKey": key()})
    data = book(client, "trip-001")
    assert data["items"] == [] and data["budget"] is None


def test_rupees_read_the_indian_way():
    assert [expense_service.inr(p) for p in (0, 5000, 61250, 12405000, 1234567800, -2500)] == ["₹0", "₹50", "₹612.50", "₹1,24,050", "₹1,23,45,678", "-₹25"]


def test_report_cells_starting_like_a_formula_stay_text():
    assert [expense_service._cell(x) for x in ("=1+1", "+91 98", "-5", "@SUM", "Lunch", None)] == ["'=1+1", "'+91 98", "'-5", "'@SUM", "Lunch", ""]


def test_claim_references_are_short_and_unambiguous():
    refs = {expense_service._reference() for _ in range(200)}
    assert len(refs) == 200 and all(r.startswith("RR-") and len(r) == 9 and not set(r[3:]) & set("01IOL") for r in refs)


def test_the_trips_own_date_comes_from_its_time_zone():
    from app.models import Trip

    trip = Trip(trip_id="t", utc_offset="+05:30")
    assert expense_service.trip_today(trip, datetime(2030, 1, 15, 20, 0, tzinfo=UTC)) == date(2030, 1, 16)
