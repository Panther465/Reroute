"""Google Maps, with a key: Google's map for the app (tile sessions), Google's place search, and the details and
places nearby Rico's guide shows. Without a key, or when Google can't answer, OpenStreetMap's as before. Google
itself is stood in for here."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.adapters import google_maps, guide, photos
from app.adapters.places import FoundPlace
from app.cities import city as supported_city
from app.config import Settings
from app.schemas import RooAgentOut
from app.services import places as place_service
from app.services.roo_agent.tools import Turn, call_tool

TRIP = {
    "tripId": "trip-001",
    "citySlug": "bengaluru",
    "cityName": "Bengaluru",
    "utcOffset": "+05:30",
    "stayLabel": "Hotel near Majestic",
    "stayPlace": {"placeId": "hotel-majestic", "name": "Hotel near Majestic", "area": "Majestic", "lat": 12.9767, "lng": 77.5713},
    "tasks": [],
}
LALBAGH = {
    "id": "ChIJlalbagh",
    "displayName": {"text": "Lalbagh Botanical Garden"},
    "location": {"latitude": 12.9507, "longitude": 77.5848},
    "primaryTypeDisplayName": {"text": "Botanical garden"},
    "rating": 4.5,
    "userRatingCount": 98765,
    "currentOpeningHours": {
        "openNow": True,
        "weekdayDescriptions": [f"{d}: 6:00 AM – 7:00 PM" for d in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")],
    },
    "googleMapsUri": "https://maps.google.com/?cid=1",
    "photos": [{"name": "places/ChIJlalbagh/photos/P1", "authorAttributions": [{"displayName": "Asha R", "uri": "https://maps.google.com/maps/contrib/1"}]}],
}


@pytest.fixture
def keyed(monkeypatch):
    """A Google Maps key on this server."""
    monkeypatch.setattr(google_maps, "get_settings", lambda: Settings(app_env="test", google_maps_api_key="test-maps-key"))


def _google(answer, seen: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(request)

    return httpx.MockTransport(handler)


# ---------- the map's tiles ----------


def test_a_tile_session_is_made_once_and_kept_till_a_day_before_it_ends(keyed, fake_redis):
    seen: list[httpx.Request] = []
    ends = int(time.time()) + 14 * 24 * 3600
    transport = _google(
        lambda r: httpx.Response(200, json={"session": "S-light", "expiry": str(ends), "tileWidth": 256, "tileHeight": 256, "imageFormat": "png"}), seen
    )
    with httpx.Client(transport=transport) as client:
        first = google_maps.tile_session(False, client)
        again = google_maps.tile_session(False, client)
    assert first == again == google_maps.TileSession("S-light", ends) and len(seen) == 1
    (request,) = seen
    assert str(request.url) == "https://tile.googleapis.com/v1/createSession?key=test-maps-key"
    body = json.loads(request.content)
    assert body == {"mapType": "roadmap", "language": "en-IN", "region": "IN", "scale": "scaleFactor2x", "highDpi": True}
    assert 12 * 24 * 3600 < fake_redis.ttl("gmaps:tiles:light") <= 13 * 24 * 3600


def test_the_dark_map_is_googles_roadmap_in_reroutes_night_colours(keyed):
    seen: list[httpx.Request] = []
    transport = _google(lambda r: httpx.Response(200, json={"session": "S-dark", "expiry": str(int(time.time()) + 3600 * 48)}), seen)
    with httpx.Client(transport=transport) as client:
        assert google_maps.tile_session(True, client).session == "S-dark"
    styles = json.loads(seen[0].content)["styles"]
    assert styles == google_maps.DARK_STYLE
    # Label text always gets both a fill and a stroke, as Google asks.
    texts = {(s.get("featureType", "all"), s["elementType"]) for s in styles if s.get("elementType", "").startswith("labels.text")}
    assert ("all", "labels.text.fill") in texts and ("all", "labels.text.stroke") in texts


def test_without_a_key_or_when_google_says_no_there_is_no_google_map(monkeypatch, fake_redis):
    monkeypatch.setattr(google_maps, "get_settings", lambda: Settings(app_env="test"))
    assert not google_maps.enabled()
    with pytest.raises(google_maps.GoogleUnavailable):
        google_maps.tile_session(False)
    monkeypatch.setattr(google_maps, "get_settings", lambda: Settings(app_env="test", google_maps_api_key="test-maps-key"))
    refused = _google(lambda r: httpx.Response(403, json={"error": {"status": "PERMISSION_DENIED"}}), [])
    with httpx.Client(transport=refused) as client, pytest.raises(google_maps.GoogleUnavailable):
        google_maps.tile_session(False, client)
    assert fake_redis.get("gmaps:tiles:light") is None


# ---------- place search ----------


def test_place_search_asks_google_inside_the_city_and_names_each_places_area(keyed):
    seen: list[httpx.Request] = []
    places = [
        {
            "id": "ChIJbank",
            "displayName": {"text": "SBI, 80 Feet Road"},
            "location": {"latitude": 12.9352, "longitude": 77.6195},
            "shortFormattedAddress": "80 Feet Rd, Koramangala, Bengaluru",
            "addressComponents": [
                {"longText": "Koramangala", "types": ["sublocality_level_1", "sublocality"]},
                {"longText": "Bengaluru", "types": ["locality"]},
            ],
        },
        {
            "id": "ChIJcafe",
            "displayName": {"text": "Third Wave Coffee"},
            "location": {"latitude": 12.97, "longitude": 77.64},
            "shortFormattedAddress": "100 Feet Rd, Indiranagar, Bengaluru",
        },
        {"id": "ChIJnowhere", "displayName": {"text": "No point"}},
    ]
    where = supported_city("bengaluru")
    with httpx.Client(transport=_google(lambda r: httpx.Response(200, json={"places": places}), seen)) as client:
        found = google_maps.search_places(" SBI bank ", where, client)
    assert found == [
        FoundPlace("gpl-ChIJbank", "SBI, 80 Feet Road", "Koramangala", 77.6195, 12.9352, None),
        FoundPlace("gpl-ChIJcafe", "Third Wave Coffee", "Indiranagar", 77.64, 12.97, None),
    ]
    (request,) = seen
    assert request.headers["x-goog-api-key"] == "test-maps-key" and "places.addressComponents" in request.headers["x-goog-fieldmask"]
    body = json.loads(request.content)
    west, south, east, north = where.bbox
    assert body["textQuery"] == "SBI bank" and body["regionCode"] == "IN"
    assert body["locationRestriction"] == {"rectangle": {"low": {"latitude": south, "longitude": west}, "high": {"latitude": north, "longitude": east}}}


def test_place_search_uses_google_with_a_key_and_openstreetmap_without_or_when_google_fails(monkeypatch):
    asked: list[str] = []

    def google(text, where):
        asked.append("google")
        raise google_maps.GoogleUnavailable("quota")

    class Nominatim:
        def __init__(self, redis):
            pass

        def search(self, text, where):
            asked.append("osm")
            return []

    monkeypatch.setattr(place_service.google_maps, "search_places", google)
    monkeypatch.setattr(place_service, "NominatimSearch", Nominatim)
    where = supported_city("bengaluru")
    monkeypatch.setattr(place_service.google_maps, "enabled", lambda: True)
    place_service._search_more("bank", where)
    monkeypatch.setattr(place_service.google_maps, "enabled", lambda: False)
    place_service._search_more("bank", where)
    assert asked == ["google", "osm", "osm"]
    # Google finding nothing: OpenStreetMap may know it by another name.
    monkeypatch.setattr(place_service.google_maps, "enabled", lambda: True)
    monkeypatch.setattr(place_service.google_maps, "search_places", lambda text, where: asked.append("google") or [])
    place_service._search_more("Pattandur Agrahara", where)
    assert asked[-2:] == ["google", "osm"]


# ---------- Rico's guide ----------


class FakeApi:
    async def get(self, path: str, **params):
        raise AssertionError(f"no API call expected: {path}")


def _turn() -> Turn:
    return Turn(api=FakeApi(), trip=TRIP, trips=[], simulated=True)  # type: ignore[arg-type]


def test_places_nearby_come_from_google_with_their_rating_and_the_best_known_first(keyed, monkeypatch):
    seen: list[httpx.Request] = []
    nearby = {
        "places": [
            {**LALBAGH, "userRatingCount": 98765},
            {
                "id": "ChIJcubbon",
                "displayName": {"text": "Cubbon Park"},
                "location": {"latitude": 12.9763, "longitude": 77.5929},
                "primaryTypeDisplayName": {"text": "Park"},
                "rating": 4.6,
                "userRatingCount": 300,
            },
        ]
    }
    real = httpx.AsyncClient

    def client(*a, **kw):
        return real(transport=_google(lambda r: httpx.Response(200, json=nearby), seen))

    monkeypatch.setattr(google_maps.httpx, "AsyncClient", client)

    async def no_overpass(*a, **kw):
        raise AssertionError("OpenStreetMap isn't asked when Google answers")

    monkeypatch.setattr(guide, "places_near", no_overpass)
    turn = _turn()
    out = asyncio.run(call_tool(turn, "places_near", {"kind": "do"}))
    assert out == {
        "near": "Hotel near Majestic",
        "places": [
            {"name": "Lalbagh Botanical Garden", "what": "botanical garden", "km": 3.2, "rating": 4.5, "wellKnown": True},
            {"name": "Cubbon Park", "what": "park", "km": 2.3, "rating": 4.6},
        ],
    }
    assert turn.reads == ["Looked on Google Maps for things to do near Hotel near Majestic"]
    body = json.loads(seen[0].content)
    assert body["includedTypes"] == ["park", "zoo", "amusement_park", "aquarium"] and body["rankPreference"] == "POPULARITY"
    assert body["locationRestriction"]["circle"]["center"] == {"latitude": 12.9767, "longitude": 77.5713}


def test_places_rico_shows_get_googles_rating_hours_photo_and_page(keyed, monkeypatch):
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/media"):
            return httpx.Response(200, json={"name": "places/ChIJlalbagh/photos/P1/media", "photoUri": "https://lh3.googleusercontent.com/p/abc=w800"})
        return httpx.Response(200, json={"places": [LALBAGH]})

    real = httpx.AsyncClient
    monkeypatch.setattr(google_maps.httpx, "AsyncClient", lambda *a, **kw: real(transport=_google(answer, seen)))

    async def commons(place, city=None, client=None):
        return []

    async def city_guide(city, client=None):
        return guide.CityGuide("Bengaluru", "Big.", see=(guide.Listing("Lalbagh Botanical Garden", "Glasshouse.", "6AM-7PM", "₹30", True, 12.9507, 77.5848),))

    monkeypatch.setattr(photos, "place_photos", commons)
    monkeypatch.setattr(guide, "city_guide", city_guide)
    turn = _turn()
    asyncio.run(call_tool(turn, "city_guide", {}))
    out = asyncio.run(call_tool(turn, "show_places", {"places": [{"name": "Lalbagh", "why": "Old trees."}]}))
    assert out["onScreen"] == ["Lalbagh Botanical Garden"]
    (card,) = turn.shown["places"]
    today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%A")
    assert card["rating"] == 4.5 and card["ratings"] == 98765 and card["open_now"] is True
    assert (
        card["today_hours"] == "6:00 AM – 7:00 PM"
        and today in LALBAGH["currentOpeningHours"]["weekdayDescriptions"][datetime.now(ZoneInfo("Asia/Kolkata")).weekday()]
    )
    assert card["photo"] == {
        "url": "https://lh3.googleusercontent.com/p/abc=w800",
        "thumb_url": "https://lh3.googleusercontent.com/p/abc=w800",
        "title": "Lalbagh Botanical Garden",
        "credit": "Photo: Asha R, Google Maps",
        "source_url": "https://maps.google.com/maps/contrib/1",
    }
    assert (card["source"], card["maps_url"], card["google_place_id"], card["what"]) == (
        "Google Maps",
        "https://maps.google.com/?cid=1",
        "ChIJlalbagh",
        "Botanical garden",
    )
    # The guide's own hours and price stay; the place is where Google puts it.
    assert (card["hours"], card["price"], card["km"]) == ("6AM-7PM", "₹30", 3.2)
    assert "Checked them on Google Maps" in turn.reads and "Found photos on Wikimedia Commons" not in turn.reads
    # Asked near where the guide put it, and the photo's address without a redirect (it carries no key).
    search, media = seen
    assert json.loads(search.content)["locationBias"] == {"circle": {"center": {"latitude": 12.9507, "longitude": 77.5848}, "radius": 3000.0}}
    assert media.url.params["skipHttpRedirect"] == "true" and media.headers["x-goog-api-key"] == "test-maps-key"
    RooAgentOut.model_validate({"reply": "Here!", "places": turn.shown})


def test_a_google_place_somewhere_else_with_the_same_name_isnt_taken(keyed, monkeypatch):
    far = {**LALBAGH, "location": {"latitude": 13.2, "longitude": 77.9}}
    real = httpx.AsyncClient
    monkeypatch.setattr(google_maps.httpx, "AsyncClient", lambda *a, **kw: real(transport=_google(lambda r: httpx.Response(200, json={"places": [far]}), [])))
    with pytest.raises(google_maps.GoogleUnavailable):
        asyncio.run(google_maps.place_details("Lalbagh Botanical Garden", "Bengaluru", (12.9507, 77.5848)))


def test_without_a_key_rico_shows_places_as_before(monkeypatch):
    monkeypatch.setattr(google_maps, "get_settings", lambda: Settings(app_env="test"))

    async def commons(place, city=None, client=None):
        return []

    async def city_guide(city, client=None):
        return guide.CityGuide("Bengaluru", "Big.", see=(guide.Listing("Cubbon Park", "Green.", lat=12.9763, lng=77.5929),))

    monkeypatch.setattr(photos, "place_photos", commons)
    monkeypatch.setattr(guide, "city_guide", city_guide)
    turn = _turn()
    asyncio.run(call_tool(turn, "city_guide", {}))
    asyncio.run(call_tool(turn, "show_places", {"places": [{"name": "Cubbon Park", "why": "Shade."}]}))
    (card,) = turn.shown["places"]
    assert card["source"] == "Wikivoyage" and "rating" not in card and card["photo"] is None


# ---------- the app asks which map to draw ----------


@pytest.mark.db
def test_the_app_is_told_which_map_to_draw(client, monkeypatch):
    from app.routes import roads

    # No key: OpenStreetMap's.
    assert client.get("/v1/maps/tiles").json()["provider"] == "open"
    # A key: Google's, light and dark, with the app's own key in the tile addresses.
    ends = int(time.time()) + 14 * 24 * 3600
    monkeypatch.setattr(roads.google_maps, "enabled", lambda: True)
    monkeypatch.setattr(roads.google_maps, "tile_session", lambda dark, client=None: google_maps.TileSession("S/dark" if dark else "S-light", ends))
    monkeypatch.setattr(roads, "get_settings", lambda: Settings(app_env="test", google_maps_api_key="server-key", google_maps_browser_key="app-key"))
    out = client.get("/v1/maps/tiles").json()
    assert out["provider"] == "google"
    assert out["tilesUrl"] == "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=S-light&key=app-key"
    assert out["darkTilesUrl"] == "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=S%2Fdark&key=app-key"
    assert out["viewportUrl"] == "https://tile.googleapis.com/tile/v1/viewport?session=S-light&key=app-key"
    assert out["expiresAt"].startswith(datetime.fromtimestamp(ends - google_maps.SESSION_MARGIN_S).astimezone().strftime("%Y-")[:5])

    # Google saying no: OpenStreetMap's again, never an error.
    def refused(dark, client=None):
        raise google_maps.GoogleUnavailable("PERMISSION_DENIED")

    monkeypatch.setattr(roads.google_maps, "tile_session", refused)
    assert client.get("/v1/maps/tiles").json()["provider"] == "open"
    # Only for someone signed in.
    client.headers.pop("Authorization")
    assert client.get("/v1/maps/tiles").status_code == 401
