"""Photos of a place for Rico to show: Wikimedia Commons' search, photographs only, each with its credit."""

from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.adapters import photos


def _client(answer, seen: list[httpx.Request]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _file(
    index: int,
    name: str,
    mime: str = "image/jpeg",
    width: int = 4000,
    height: int = 3000,
    artist: str = "<a href='//x'>A. Kumar</a>",
    licence: str = "CC BY-SA 4.0",
) -> dict:
    return {
        "pageid": index,
        "ns": 6,
        "title": f"File:{name}",
        "index": index,
        "imageinfo": [
            {
                "url": f"https://upload.wikimedia.org/full/{name}",
                "thumburl": f"https://upload.wikimedia.org/thumb/{name}/800px-{name}",
                "descriptionurl": f"https://commons.wikimedia.org/wiki/File:{name}",
                "mime": mime,
                "width": width,
                "height": height,
                "extmetadata": {"Artist": {"value": artist}, "LicenseShortName": {"value": licence}},
            }
        ],
    }


COMMONS = {
    "query": {
        "pages": [
            _file(3, "Lalbagh_glasshouse_at_dusk.jpg", artist="Unnamed"),
            _file(1, "Lalbagh_Botanical_Garden_lake.jpg"),
            # Not photographs of the place, or too small to fill a screen: left out.
            _file(2, "Lalbagh_location_map.png", mime="image/png"),
            _file(4, "Lalbagh_logo.svg.png", mime="image/png"),
            _file(5, "Lalbagh_tiny.jpg", width=320, height=240),
            _file(6, "Lalbagh_scan.tif", mime="image/tiff"),
        ]
    }
}


def test_photos_are_commons_photographs_best_match_first_each_with_its_credit_and_kept_a_week(fake_redis):
    seen: list[httpx.Request] = []
    found = asyncio.run(photos.place_photos("Lalbagh Botanical Garden", "Bengaluru", client=_client(lambda r: httpx.Response(200, json=COMMONS), seen)))
    assert [p.title for p in found] == ["Lalbagh Botanical Garden lake", "Lalbagh glasshouse at dusk"]
    first = found[0]
    assert first.thumb_url == "https://upload.wikimedia.org/thumb/Lalbagh_Botanical_Garden_lake.jpg/800px-Lalbagh_Botanical_Garden_lake.jpg"
    assert first.credit == "Photo: A. Kumar, CC BY-SA 4.0, Wikimedia Commons"
    assert first.source_url == "https://commons.wikimedia.org/wiki/File:Lalbagh_Botanical_Garden_lake.jpg"
    # Only the place and its city go to Commons, asking for pictures in its files.
    [request] = seen
    asked = parse_qs(urlparse(str(request.url)).query)
    assert asked["gsrsearch"] == ["Lalbagh Botanical Garden Bengaluru filetype:bitmap"] and asked["gsrnamespace"] == ["6"]
    assert request.headers["user-agent"].startswith("Reroute/")
    # Asked again, the same answer comes from the cache: Commons isn't asked twice.
    again = asyncio.run(photos.place_photos("Lalbagh Botanical Garden", "Bengaluru", client=_client(lambda r: httpx.Response(500), seen)))
    assert again == found and len(seen) == 1
    assert 6 * 24 * 3600 < fake_redis.ttl("photos:lalbagh botanical garden bengaluru") <= 7 * 24 * 3600


def test_the_city_is_added_only_when_the_name_lacks_it():
    assert photos.search_text("Mysore Palace", "Mysuru") == "Mysore Palace Mysuru"
    assert photos.search_text("Cubbon Park, Bengaluru", "Bengaluru") == "Cubbon Park, Bengaluru"
    assert photos.search_text("Cubbon Park", None) == "Cubbon Park"


@pytest.mark.parametrize("answer", [lambda r: httpx.Response(503), lambda r: httpx.Response(200, text="not json")])
def test_a_commons_that_fails_gives_no_photos_and_nothing_is_kept(fake_redis, answer):
    seen: list[httpx.Request] = []
    assert asyncio.run(photos.place_photos("Nandi Hills", None, client=_client(answer, seen))) == []
    assert fake_redis.get("photos:nandi hills") is None


@pytest.mark.db
def test_a_signed_in_traveller_gets_photos_of_a_place(client, monkeypatch):
    async def fake(place, city=None, client=None):
        assert (place, city) == ("Cubbon Park", "Bengaluru")
        return [photos.Photo(url="u", thumb_url="t", title="Cubbon Park", credit="Photo: B, CC0, Wikimedia Commons", source_url="s")]

    monkeypatch.setattr(photos, "place_photos", fake)
    res = client.get("/v1/places/photos", params={"place": "Cubbon Park", "city": "Bengaluru"})
    assert res.status_code == 200, res.text
    assert res.json() == [{"url": "u", "thumbUrl": "t", "title": "Cubbon Park", "credit": "Photo: B, CC0, Wikimedia Commons", "sourceUrl": "s"}]
    assert client.get("/v1/places/photos", params={"place": "x"}).status_code == 422
