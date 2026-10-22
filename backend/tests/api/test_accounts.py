"""Accounts with an email and a password, the wallet's simulated money, and simulated flights."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import session_scope
from app.main import app
from app.models import User
from app.security import hash_password, verify_password

from .conftest import key


def test_a_password_is_kept_only_as_a_salted_scrypt_hash():
    stored = hash_password("correct horse battery")
    assert stored.startswith("scrypt$16384$8$1$") and "correct horse" not in stored
    assert stored != hash_password("correct horse battery")  # a fresh salt each time
    assert verify_password("correct horse battery", stored)
    assert not verify_password("correct horse batterY", stored)
    assert not verify_password("anything", "not-a-hash") and not verify_password("anything", None)


def _guest() -> TestClient:
    return TestClient(app, base_url="https://testserver")


@pytest.mark.db
def test_sign_up_then_sign_in_with_the_same_email_and_password(client):
    guest = _guest()
    res = guest.post("/v1/auth/signup", json={"name": "Asha Rao", "email": "Asha.Rao@Example.com", "password": "rerouting-is-fun"})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["user"]["name"] == "Asha Rao" and body["user"]["email"] == "asha.rao@example.com" and not body["user"]["isDemo"]
    assert "rr_refresh" in res.cookies
    with session_scope() as db:
        user = db.scalar(select(User).where(User.email == "asha.rao@example.com"))
        assert user.password_hash.startswith("scrypt$")

    # A new account has no trips yet, and a welcome balance of simulated money.
    me = {"Authorization": f"Bearer {body['accessToken']}"}
    assert guest.get("/v1/trips", headers=me).json()["items"] == []
    wallet = guest.get("/v1/wallet", headers=me).json()
    assert wallet["balanceInr"] == 2000 and [e["kind"] for e in wallet["entries"]] == ["welcome"]

    # The email is one account, whatever its case.
    again = _guest().post("/v1/auth/signup", json={"name": "Asha", "email": "asha.rao@example.com", "password": "another-password"})
    assert again.status_code == 409 and again.json()["error"]["code"] == "EMAIL_TAKEN"

    ok = _guest().post("/v1/auth/login", json={"email": "ASHA.RAO@example.com", "password": "rerouting-is-fun"})
    assert ok.status_code == 200 and ok.json()["user"]["userId"] == body["user"]["userId"]
    wrong = _guest().post("/v1/auth/login", json={"email": "asha.rao@example.com", "password": "rerouting-is-FUN"})
    nobody = _guest().post("/v1/auth/login", json={"email": "nobody@example.com", "password": "rerouting-is-fun"})
    # The same answer for a wrong password and an unknown email.
    assert wrong.status_code == nobody.status_code == 401
    assert wrong.json()["error"]["message"] == nobody.json()["error"]["message"] == "Email or password is wrong."


@pytest.mark.db
@pytest.mark.parametrize(
    "body",
    [
        {"name": "A", "email": "not-an-email", "password": "long-enough"},
        {"name": "A", "email": "a@example.com", "password": "short"},
        {"name": "", "email": "a@example.com", "password": "long-enough"},
    ],
)
def test_sign_up_checks_its_fields(client, body):
    assert _guest().post("/v1/auth/signup", json=body).status_code == 422


@pytest.mark.db
def test_bookings_are_paid_from_the_wallet_and_refunded_when_cancelled(client):
    start = client.get("/v1/wallet").json()["balanceInr"]
    assert start == 5000  # the demo account's simulated balance

    # A business flight for two costs more than the demo balance: refused, and nothing is booked.
    flights = client.get("/v1/trips/trip-001/flight-options", params={"from": "BLR", "to": "DEL", "date": "2026-10-15"}).json()
    assert len(flights) == 5 and flights[0]["airline"] == "SkyHop" and flights[0]["originCity"] == "Bengaluru"
    flight = flights[0]
    business = next(f for f in flight["fares"] if f["cabin"] == "business")
    pair = [{"name": "Arjun Mehta", "age": 34}, {"name": "Priya Mehta", "age": 31}]
    body = {
        "kind": "flight",
        "origin": "BLR",
        "flightTo": "DEL",
        "flightDate": "2026-10-15",
        "flightNo": flight["flightNo"],
        "cabin": "business",
        "passengers": pair,
    }
    short = client.post("/v1/trips/trip-001/bookings", json={**body, "idempotencyKey": key()})
    assert short.status_code == 409 and short.json()["error"]["code"] == "INSUFFICIENT_FUNDS"
    assert f"add ₹{business['fareInr'] * 2 - start:,}" in short.json()["error"]["message"]
    assert client.get("/v1/trips/trip-001/bookings").json() == []

    # Add simulated money, then the same flight books, and the wallet shows the charge.
    topped = client.post("/v1/wallet/topups", json={"amountInr": 50000, "idempotencyKey": key()})
    assert topped.status_code == 201 and topped.json()["balanceInr"] == start + 50000
    res = client.post("/v1/trips/trip-001/bookings", json={**body, "idempotencyKey": key()})
    assert res.status_code == 201, res.text
    ticket = res.json()
    assert ticket["kind"] == "flight" and ticket["provider"] == "skyhop" and len(ticket["reference"]) == 6
    assert [p["seat"] for p in ticket["details"]["passengers"]][1][-1] == "C"  # seats side by side across the aisle in business
    wallet = client.get("/v1/wallet").json()
    assert wallet["balanceInr"] == start + 50000 - ticket["fareInr"]
    assert wallet["entries"][0]["kind"] == "booking" and wallet["entries"][0]["bookingId"] == ticket["bookingId"]

    # Cancelling refunds all but the fee; a made-up flight or airport is refused.
    cancelled = client.post(f"/v1/trips/trip-001/bookings/{ticket['bookingId']}/cancel", json={"idempotencyKey": key()}).json()
    assert cancelled["details"]["refundInr"] == ticket["fareInr"] - 1000
    assert client.get("/v1/wallet").json()["balanceInr"] == start + 50000 - 1000
    assert client.post("/v1/trips/trip-001/bookings", json={**body, "flightNo": "SH 1", "idempotencyKey": key()}).status_code == 422
    assert client.get("/v1/trips/trip-001/flight-options", params={"from": "BLR", "to": "BLR", "date": "2026-10-15"}).status_code == 422

    # A demo reset puts the demo balance back.
    client.post("/v1/trips/trip-001/demo/reset", json={"idempotencyKey": key()})
    assert client.get("/v1/wallet").json()["balanceInr"] == 5000
    assert {a["code"] for a in client.get("/v1/airports").json()} >= {"BLR", "DEL", "BOM"}
