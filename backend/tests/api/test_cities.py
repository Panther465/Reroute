"""Cities beyond Bengaluru: finding one from what a traveller types, every city on the list with its area
and no lookup, planning there with rough estimates, and a fixed time that has already passed today."""

from __future__ import annotations

from datetime import date

import pytest

from app.adapters.places import FoundCity, FoundPlace
from app.adapters.transit import StaticTransitAdapter
from app.adapters.travel_times import PlacePoint, SampleSnapshotAdapter
from app.cities import MAX_HALF, MIN_HALF, city, covers, listed_cities
from app.india import CITIES as INDIA
from app.india import in_india
from app.services.cities import _area, mentioned, slugify
from app.services.planner import Mode

from .conftest import key
from .test_flow import clock

RAJPURA = FoundCity("Rajpura", "Punjab", 76.5937, 30.4776, (76.553, 30.437, 76.633, 30.517), "n245676548")
#: Chitkara University's campus, about 7 km from the town, outside its own outline.
CHITKARA = (76.6591, 30.5157)


def names(text: str) -> list[str]:
    return [INDIA[i][0] for i in mentioned(text)]


def test_a_city_is_found_by_its_name_a_slip_or_another_name():
    assert names("bengluru")[0] == "Bengaluru"
    assert names("Bangalore")[0] == "Bengaluru"
    assert names("Gurgaon") == ["Gurugram"] and names("bombay") == ["Mumbai"]
    assert names("rajpura") == ["Rajpura"]
    assert {"Rajpura", "Rajkot"} <= set(names("raj"))  # typing the start of a name


def test_a_sentence_names_its_city_and_nothing_else():
    said = (
        "Hey so actully i am new to bengluru and i will be living in the ramson hotel i think i will reach at 9 am "
        "and then i will go to my college becoz i am new here so i wannna go there also i will have a quicl meethinga as well at 5 pm"
    )
    assert names(said) == ["Bengaluru"]
    assert names("I have a sales meeting at the office") == []  # "sales" isn't Salem
    assert names("my college is in rajpura near chitkara") == ["Rajpura"]


def test_slugs_are_plain():
    assert slugify("Rajpura") == "rajpura" and slugify("Vasco da Gama") == "vasco-da-gama"
    assert slugify("Bilaspur Himachal Pradesh") == "bilaspur-himachal-pradesh"


def test_a_city_area_reaches_past_the_town_outline():
    west, south, east, north = _area(RAJPURA)
    lng, lat = CHITKARA
    assert west <= lng <= east and south <= lat <= north


def test_every_city_on_the_list_comes_with_its_area():
    listed = listed_cities()
    assert set(listed) | {"bengaluru"} == {slugify(name) for name, _, _ in INDIA}
    for c in listed.values():
        west, south, east, north = c.bbox
        assert in_india(west, south) and in_india(east, north), c.name
        assert MIN_HALF <= round((east - west) / 2, 5) <= MAX_HALF and MIN_HALF <= round((north - south) / 2, 5) <= MAX_HALF, c.name
    # Rajpura's area takes in the campus beyond the town, as an area looked up on the day would.
    assert listed["rajpura"].contains(*CHITKARA) and listed["thrissur"].state == "Kerala"


def test_a_city_on_the_list_needs_no_lookup(monkeypatch):
    def nobody(slug):
        raise AssertionError(f"{slug} was looked up")

    monkeypatch.setattr("app.services.cities.kept_or_looked_up", nobody)
    monkeypatch.setattr("app.services.cities.a_kept_city_covers", nobody)
    monkeypatch.setattr("app.cities._kept", {})
    shaniwar_wada = (73.8553, 18.5195)
    pune = city("pune")
    assert (pune.name, pune.state) == ("Pune", "Maharashtra") and pune.contains(*shaniwar_wada) and not pune.sample
    assert covers(*shaniwar_wada) and city("bengaluru").sample


def test_a_city_without_sample_data_gets_rough_estimates_both_ways():
    hotel = PlacePoint("osm-rajpura-hotel", 76.5937, 30.4776)
    campus = PlacePoint("osm-chitkara", *CHITKARA)
    pairs = SampleSnapshotAdapter(StaticTransitAdapter({})).snapshot("rajpura", [hotel, campus], date(2026, 10, 22)).lookup()
    for pair in ((hotel.place_id, campus.place_id), (campus.place_id, hotel.place_id)):
        assert [o.mode for o in pairs[pair]] == [Mode.CAB] and pairs[pair][0].rough


class FakeNominatim:
    """OpenStreetMap without the network: it knows Rajpura, Chitkara University near it, and Kasauli."""

    calls: list[str] = []

    def __init__(self, *_):
        pass

    def settlements(self, query):
        FakeNominatim.calls.append(query)
        if query.lower().startswith("rajpura"):
            return [RAJPURA]
        if query.lower().startswith("kasauli"):
            return [FoundCity("Kasauli", "Himachal Pradesh", 76.9629, 30.8986, (76.95, 30.89, 76.97, 30.91), "n1")]
        return []

    def search(self, query, where):
        if "chitkara" not in query.lower():
            return []
        return [FoundPlace("osm-w123", "Chitkara University", "Jansla", *CHITKARA, "w123")]


@pytest.fixture
def osm(monkeypatch):
    FakeNominatim.calls = []
    monkeypatch.setattr("app.services.cities.NominatimSearch", FakeNominatim)
    monkeypatch.setattr("app.services.places.NominatimSearch", FakeNominatim)
    monkeypatch.setattr("app.cities._kept", {})
    return FakeNominatim


def plain_city(c: dict) -> tuple:
    return c["slug"], c["name"], c["state"], c["sample"]


@pytest.mark.db
def test_find_a_city_then_plan_a_trip_there(client, osm):
    # Bengaluru is built in: a slip finds it without asking OpenStreetMap.
    blr = client.get("/v1/cities", params={"q": "bengluru"}).json()
    assert [plain_city(c) for c in blr] == [("bengaluru", "Bengaluru", "Karnataka", True)] and blr[0]["bbox"] == [77.35, 12.75, 77.9, 13.2]
    # A sentence gives its one city, with where it is.
    found = client.get("/v1/cities", params={"q": "I am new to rajpura and my college is chitkara"}).json()
    assert [plain_city(c) for c in found] == [("rajpura", "Rajpura", "Punjab", False)]
    west, south, east, north = found[0]["bbox"]
    assert west < found[0]["lng"] < east and south < found[0]["lat"] < north
    # Searching a place there finds a campus outside the town's outline, and planning there starts at once.
    places = client.get("/v1/places", params={"q": "Chitkara University", "city": "rajpura"}).json()
    assert [p["name"] for p in places] == ["Chitkara University"]
    stay = {"stayPlaceId": places[0]["placeId"], "stayLabel": "Hostel", "idempotencyKey": key()}
    res = client.post("/v1/trips", json={"citySlug": "rajpura", "cityName": "anything", "startDate": "2026-10-22", "endDate": "2026-10-22", **stay})
    assert res.status_code == 201, res.text
    assert res.json()["cityName"] == "Rajpura" and res.json()["citySlug"] == "rajpura"
    assert osm.calls == []  # its area is on file: OpenStreetMap was never asked about the city


@pytest.mark.db
def test_every_city_on_the_list_to_choose_from(client, osm):
    every = client.get("/v1/cities").json()
    assert len(every) == len(INDIA) and [c["name"] for c in every] == sorted(c["name"] for c in every)
    assert all(c["lng"] and c["lat"] and len(c["bbox"]) == 4 for c in every) and osm.calls == []
    assert [plain_city(c) for c in every if c["sample"]] == [("bengaluru", "Bengaluru", "Karnataka", True)]


@pytest.mark.db
def test_a_town_off_the_list_comes_from_openstreetmap(client, osm):
    found = client.get("/v1/cities", params={"q": "Kasauli"}).json()
    assert [plain_city(c) for c in found] == [("kasauli", "Kasauli", "Himachal Pradesh", False)]
    assert (found[0]["lng"], found[0]["lat"]) == (76.9629, 30.8986) and osm.calls == ["kasauli"]
    assert client.get("/v1/cities", params={"q": "Atlantis"}).json() == []
    assert client.get("/v1/places", params={"q": "Chitkara", "city": "atlantis"}).status_code == 422


@pytest.mark.db
def test_a_fixed_time_that_has_passed_says_so(client):
    clock(client, "11:30")  # the 10:00 meeting is over before the day is planned
    res = client.post("/v1/trips/trip-001/plans", json={"idempotencyKey": key()})
    job = client.get(f"/v1/jobs/{res.json()['jobId']}").json()
    assert job["status"] == "failed", job
    assert "was at 10:00, and that time has already passed today. Let them know, or change its time if it has moved." in str(job)
