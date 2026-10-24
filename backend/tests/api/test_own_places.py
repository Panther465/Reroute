"""Places travellers add themselves: theirs alone until a moderator approves sharing one, found in place
search and usable for tasks, inside India and the city, with a cap, a daily limit, and deletion that leaves
a trip its place."""

from __future__ import annotations

import pytest
from sqlalchemy import select, text

from app.db import engine, session_scope
from app.models import Place
from app.routes import places as place_routes
from app.services import places as place_service

from .conftest import key

#: Beside the sample bank on 80 Feet Road, Koramangala, in the demo city.
KORAMANGALA = (77.6201, 12.9349)


def own(name: str = "Aunt's flat", category: str = "stay", at: tuple[float, float] = KORAMANGALA, city: str = "bengaluru", **more) -> dict:
    return {"name": name, "category": category, "lng": at[0], "lat": at[1], "citySlug": city, "idempotencyKey": key(), **more}


def sign_up(client, name: str) -> dict:
    res = client.post("/v1/auth/signup", json={"name": name, "email": f"{name.lower()}@example.com", "password": "a long password"})
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['accessToken']}"}


def moderator(client) -> dict:
    return {"Authorization": f"Bearer {client.post('/v1/auth/demo', json={'as': 'moderator'}).json()['accessToken']}"}


def found(client, q: str, headers: dict | None = None) -> list[dict]:
    res = client.get("/v1/places", params={"q": q, "city": "bengaluru"}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def add(client, headers: dict | None = None, **body) -> dict:
    res = client.post("/v1/me/places", json=own(**body), headers=headers)
    assert res.status_code == 201, res.text
    return res.json()


@pytest.fixture(autouse=True)
def no_osm(monkeypatch):
    """OpenStreetMap knows nothing here: search answers only with places Reroute has."""

    class Nothing:
        def __init__(self, *_):
            pass

        def search(self, query, where):
            return []

    monkeypatch.setattr("app.services.places.NominatimSearch", Nothing)


@pytest.mark.db
def test_a_place_of_your_own_is_yours_alone(client):
    mine = add(client, note="Gate 2, ask for Ravi")
    assert mine["status"] == "private" and mine["mine"] and mine["category"] == "stay" and mine["note"] == "Gate 2, ask for Ravi"
    # Its area is the nearest known place's.
    assert mine["area"] == "Koramangala" and mine["placeId"].startswith("own-")
    first = found(client, "aunt")[0]
    assert first["placeId"] == mine["placeId"] and first["mine"] and first["category"] == "stay" and "note" not in first
    assert [p["placeId"] for p in client.get("/v1/me/places").json()] == [mine["placeId"]]
    assert client.get("/v1/me/places", params={"city": "pune"}).json() == []

    # Nobody else finds it, lists it or plans with it, even knowing its ID.
    asha = sign_up(client, "Asha")
    assert found(client, "aunt", asha) == [] and client.get("/v1/me/places", headers=asha).json() == []
    trip = {"citySlug": "bengaluru", "cityName": "Bengaluru", "startDate": "2026-10-22", "endDate": "2026-10-22", "stayLabel": "Flat"}
    res = client.post("/v1/trips", json={**trip, "stayPlaceId": mine["placeId"], "idempotencyKey": key()}, headers=asha)
    assert res.status_code == 422 and res.json()["error"]["message"] == "Choose a place from the search results."

    # Its owner can.
    task = {"title": "Dinner with family", "placeId": mine["placeId"], "durationMin": 90, "idempotencyKey": key()}
    res = client.post("/v1/trips/trip-001/tasks", json=task, params={"replan": "false"})
    assert res.status_code == 201, res.text
    assert res.json()["place"]["mine"] and res.json()["place"]["name"] == "Aunt's flat"


@pytest.mark.db
def test_a_shared_place_shows_to_everyone_once_a_moderator_approves_it(client):
    chai = add(client, name="Chai point by the gate", category="food", note="Best before 9", share=True)
    assert chai["status"] == "pending"
    asha, mod = sign_up(client, "Asha"), moderator(client)
    assert found(client, "chai", asha) == []

    # Moderators see it, never its note, and only moderators decide.
    queue = client.get("/v1/places/review", headers=mod).json()
    assert [(p["placeId"], p["cityName"], p["addedBy"]) for p in queue] == [(chai["placeId"], "Bengaluru", "usr-demo-traveller")]
    assert "note" not in queue[0]
    assert client.get("/v1/places/review", headers=asha).status_code == 403
    assert client.post(f"/v1/places/{chai['placeId']}/approve", json={"idempotencyKey": key()}, headers=asha).status_code == 403

    res = client.post(f"/v1/places/{chai['placeId']}/approve", json={"idempotencyKey": key()}, headers=mod)
    assert res.status_code == 200 and res.json()["status"] == "approved"
    theirs = found(client, "chai", asha)
    assert [(p["placeId"], p["mine"], p["category"]) for p in theirs] == [(chai["placeId"], False, "food")]
    assert client.get("/v1/me/places").json()[0]["status"] == "approved"
    assert client.get("/v1/places/review", headers=mod).json() == []

    # A moderator can change their mind: it's the traveller's own again, with the reason.
    res = client.post(f"/v1/places/{chai['placeId']}/reject", json={"reason": "Looks like a private home.", "idempotencyKey": key()}, headers=mod)
    assert res.json()["status"] == "rejected"
    assert found(client, "chai", asha) == []
    back = client.get("/v1/me/places").json()[0]
    assert (back["status"], back["rejectReason"]) == ("rejected", "Looks like a private home.")
    # A place nobody asked to share isn't the moderators' to see.
    private = add(client, name="Cousin's house")
    assert client.post(f"/v1/places/{private['placeId']}/approve", json={"idempotencyKey": key()}, headers=mod).status_code == 404


@pytest.mark.db
def test_a_moderator_never_approves_their_own_place(client):
    mod = moderator(client)
    theirs = add(client, mod, name="Tiffin centre", category="food", share=True)
    res = client.post(f"/v1/places/{theirs['placeId']}/approve", json={"idempotencyKey": key()}, headers=mod)
    assert res.status_code == 403 and res.json()["error"]["message"] == "Another moderator checks the places you add."


@pytest.mark.db
@pytest.mark.parametrize(
    ("body", "message"),
    [
        ({"at": (-0.1276, 51.5072)}, "That point is outside India. Reroute plans trips in India only."),
        ({"at": (77.2090, 28.6139)}, "That point is outside Bengaluru. Add places in the city you're planning in."),
        ({"city": "atlantis"}, "Reroute doesn't cover that city yet."),
        ({"name": "x" * 81}, "name: String should have at most 80 characters"),
        ({"name": " "}, "name: String should have at least 2 characters"),
        ({"note": "n" * 281}, "note: String should have at most 280 characters"),
        ({"category": "bar"}, "category: Input should be 'food', 'stay', 'sight', 'shop', 'transit' or 'other'"),
    ],
)
def test_points_names_and_notes_are_checked(client, body, message):
    res = client.post("/v1/me/places", json=own(**body))
    assert res.status_code == 422 and res.json()["error"]["message"] == message
    assert client.get("/v1/me/places").json() == []


@pytest.mark.db
def test_a_traveller_keeps_so_many_places_and_adds_so_many_a_day(client, monkeypatch):
    monkeypatch.setattr(place_service, "MAX_OWN", 2)
    first = add(client, name="One")
    add(client, name="Two")
    res = client.post("/v1/me/places", json=own(name="Three"))
    assert res.status_code == 409 and res.json()["error"]["code"] == "TOO_MANY_PLACES"
    # Deleting one makes room.
    assert client.delete(f"/v1/me/places/{first['placeId']}").status_code == 204
    add(client, name="Three")

    monkeypatch.setattr(place_routes, "ADDS_PER_DAY", 4)
    res = client.post("/v1/me/places", json=own(name="Five"))
    assert res.status_code == 429 and res.json()["error"]["code"] == "RATE_LIMITED" and int(res.headers["Retry-After"]) > 0
    # A replay of an add that went through is the same add, not another.
    body = own(name="Six")
    monkeypatch.setattr(place_routes, "ADDS_PER_DAY", 100)
    monkeypatch.setattr(place_service, "MAX_OWN", 100)
    once, again = client.post("/v1/me/places", json=body), client.post("/v1/me/places", json=body)
    assert once.status_code == again.status_code == 201 and once.json() == again.json()
    assert len(client.get("/v1/me/places").json()) == 3


@pytest.mark.db
def test_deleting_a_place_leaves_a_trip_that_goes_there_its_place(client):
    asha = sign_up(client, "Asha")
    office = add(client, name="Office annex", category="other")
    assert client.delete(f"/v1/me/places/{office['placeId']}", headers=asha).status_code == 404
    assert client.delete(f"/v1/me/places/{office['placeId']}").status_code == 204
    assert client.get("/v1/me/places").json() == [] and found(client, "annex") == []
    with session_scope() as db:
        assert db.get(Place, office["placeId"]) is None

    # In a task: it leaves the traveller's places, search and the map, but the trip keeps it, without the note.
    house = add(client, name="Cousin's house", note="Blue gate")
    task = {"title": "Visit cousin", "placeId": house["placeId"], "durationMin": 60, "idempotencyKey": key()}
    res = client.post("/v1/trips/trip-001/tasks", json=task, params={"replan": "false"})
    assert res.status_code == 201
    task_id = res.json()["taskId"]
    assert client.delete(f"/v1/me/places/{house['placeId']}").status_code == 204
    assert client.get("/v1/me/places").json() == [] and found(client, "cousin") == []
    kept = next(t for t in client.get("/v1/trips/trip-001").json()["tasks"] if t["title"] == "Visit cousin")
    assert kept["place"]["name"] == "Cousin's house" and not kept["place"]["mine"]
    with session_scope() as db:
        row = db.get(Place, house["placeId"])
        assert (row.status, row.note) == ("deleted", None)
    # It can't be picked again, and it's gone for good as far as its owner can tell.
    again = {**task, "idempotencyKey": key()}
    assert client.post("/v1/trips/trip-001/tasks", json=again).status_code == 422
    assert client.delete(f"/v1/me/places/{house['placeId']}").status_code == 404
    # Once no task goes there, it's gone from the database too.
    assert client.delete(f"/v1/trips/trip-001/tasks/{task_id}").status_code == 204
    with session_scope() as db:
        assert db.get(Place, house["placeId"]) is None


@pytest.mark.db
def test_a_deleted_place_goes_once_its_task_moves_elsewhere(client):
    shop = add(client, name="Tailor", category="shop")
    task = {"title": "Pick up the suit", "placeId": shop["placeId"], "durationMin": 30, "idempotencyKey": key()}
    task_id = client.post("/v1/trips/trip-001/tasks", json=task, params={"replan": "false"}).json()["taskId"]
    assert client.delete(f"/v1/me/places/{shop['placeId']}").status_code == 204
    res = client.patch(f"/v1/trips/trip-001/tasks/{task_id}", json={"placeId": "koramangala-bank"})
    assert res.status_code == 200 and res.json()["task"]["placeId"] == "koramangala-bank"
    with session_scope() as db:
        assert db.get(Place, shop["placeId"]) is None


@pytest.mark.db
def test_deleting_an_account_keeps_only_shared_places_other_trips_go_to(client):
    asha, mod = sign_up(client, "Asha"), moderator(client)
    shared = add(client, asha, name="Bus stand chai", category="food", note="Only mornings", share=True)
    private = add(client, asha, name="Asha's hostel")
    trip = {"citySlug": "bengaluru", "cityName": "Bengaluru", "startDate": "2026-10-22", "endDate": "2026-10-22", "stayLabel": "Hostel"}
    assert client.post("/v1/trips", json={**trip, "stayPlaceId": private["placeId"], "idempotencyKey": key()}, headers=asha).status_code == 201
    client.post(f"/v1/places/{shared['placeId']}/approve", json={"idempotencyKey": key()}, headers=mod)
    # The demo traveller plans a stop there.
    task = {"title": "Chai", "placeId": shared["placeId"], "durationMin": 15, "idempotencyKey": key()}
    assert client.post("/v1/trips/trip-001/tasks", json=task, params={"replan": "false"}).status_code == 201

    asha_id = client.get("/v1/me", headers=asha).json()["userId"]
    with engine().begin() as conn:
        conn.execute(text("DELETE FROM users WHERE user_id = :u"), {"u": asha_id})
    with session_scope() as db:
        assert db.get(Place, private["placeId"]) is None
        kept = db.get(Place, shared["placeId"])
        assert (kept.owner_id, kept.note, kept.status) == (None, None, "approved")
        assert db.scalars(select(Place.place_id).where(Place.owner_id == asha_id)).all() == []
    assert found(client, "bus stand")[0]["placeId"] == shared["placeId"]


@pytest.mark.db
def test_nobody_else_books_tickets_to_your_place(client):
    mine = add(client, name="Rooftop garden", category="sight")
    asha = sign_up(client, "Asha")
    trip = {
        "citySlug": "bengaluru",
        "cityName": "Bengaluru",
        "startDate": "2026-10-22",
        "endDate": "2026-10-22",
        "stayLabel": "Hotel",
        "stayPlaceId": "hotel-majestic",
    }
    res = client.post("/v1/trips", json={**trip, "idempotencyKey": key()}, headers=asha)
    assert res.status_code == 201, res.text
    tickets = {"kind": "ticket", "placeId": mine["placeId"], "optionId": "entry"}
    res = client.post(f"/v1/trips/{res.json()['tripId']}/bookings", json={**tickets, "visitDate": "2026-10-22", "idempotencyKey": key()}, headers=asha)
    assert res.status_code == 422, res.text
    # Its owner can.
    res = client.post("/v1/trips/trip-001/bookings", json={**tickets, "visitDate": "2026-10-15", "idempotencyKey": key()})
    assert res.status_code == 201, res.text
    assert res.json()["details"]["place"] == "Rooftop garden"
