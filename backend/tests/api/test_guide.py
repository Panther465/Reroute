"""Rico as a local guide: Wikivoyage's city guides, OpenStreetMap's places near a point (Overpass) and answers from
the web (Gemini with Google Search). Every call is answered here: nothing goes to the real services."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import parse_qs

import httpx
import pytest
import redis

from app.adapters import guide
from app.config import get_settings

WIKIVOYAGE = "https://en.wikivoyage.org/w/api.php"
OVERPASS = "https://overpass-api.de/api/interpreter"


@pytest.fixture
def sources(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "wikivoyage_url", WIKIVOYAGE)
    monkeypatch.setattr(s, "overpass_url", OVERPASS)


def _client(answer, seen: list[httpx.Request]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _down(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectTimeout("no answer")


# ---------- Wikivoyage ----------

MYSURU = """{{pagebanner|Mysore Palace banner.jpg}}
'''Mysuru''' (Kannada: ಮೈಸೂರು) is the cultural capital of [[Karnataka]].
{{geo|12.30|76.65|zoom=13}}
==Understand==
* {{see | name=Not a place to see | content=Listed under Understand, so left out. }}
==See==
[[File:Mysore Palace.jpg|thumb|The palace]]
* {{see
| name=Mysore Palace | alt=Amba Vilas | url= | email=
| address= | lat=12.305 | long=76.655 | directions={{station|Mysuru|blue}}
| hours=10AM-5:30PM | price=₹100
| wikidata=Q1191170
| content=The seat of the [[Wodeyar dynasty|Wodeyars]], lit by 97,000 bulbs on Sunday evenings. A must.
}}
* {{see | name=Rail Museum | content= }}
* {{see | name=[[Chamundi Hill]] | wikidata=Q5070214 | content=A hilltop temple, 1,000 steps up. }}
* {{listing | type=see | name=St. Philomena's Church | content=''Neo-Gothic'' spires. }}
* {{see | name= | content=A listing with no name is left out. }}
==Do==
* {{do | name=Brindavan Gardens | content=Musical fountains at dusk. }}
==Eat==
* {{eat | name=Mylari | price=₹60 | content=Famous for its soft dosa. }}
==Go next==
"""
#: Two short sentences, then one too long to fit in the summary.
EXTRACT = "Mysuru (Kannada: ಮೈಸೂರು) is the cultural capital of Karnataka. Its palace is lit every Sunday. " + "It has much more to say, " * 15 + "and ends."


def _page(title: str, wikitext: str, extract: str = "") -> dict:
    return {"pageid": 1, "ns": 0, "title": title, "extract": extract, "revisions": [{"slots": {"main": {"content": wikitext}}}]}


def _wikivoyage(*pages: dict) -> dict:
    return {"batchcomplete": True, "query": {"pages": list(pages)}}


def test_a_city_guide_is_a_short_summary_and_a_few_named_places_kept_a_week(sources, fake_redis):
    seen: list[httpx.Request] = []
    client = _client(lambda r: httpx.Response(200, json=_wikivoyage(_page("Mysuru", MYSURU, EXTRACT))), seen)

    found = asyncio.run(guide.city_guide("  Mysore ", client=client))
    again = asyncio.run(guide.city_guide("mysore", client=client))

    assert found == again and len(seen) == 1
    (request,) = seen
    assert request.headers["user-agent"] == "Reroute/1.0 (travel planner)"
    asked = request.url.params
    assert (asked["titles"], asked["redirects"], asked["prop"], asked["exintro"]) == ("Mysore", "1", "extracts|revisions", "1")
    assert found.title == "Mysuru"
    # Whole sentences that fit, without the name in other languages.
    assert found.summary == "Mysuru is the cultural capital of Karnataka. Its palace is lit every Sunday."
    # The better known (with a Wikidata entry) first, then the rest in the guide's order.
    assert [x.name for x in found.see] == ["Mysore Palace", "Chamundi Hill", "Rail Museum", "St. Philomena's Church"]
    assert found.see[0] == guide.Listing("Mysore Palace", "The seat of the Wodeyars, lit by 97,000 bulbs on Sunday evenings.", "10AM-5:30PM", "₹100", True)
    assert found.see[2] == guide.Listing("Rail Museum") and found.see[3].about == "Neo-Gothic spires."
    assert [x.name for x in found.do] == ["Brindavan Gardens"] and found.eat == (guide.Listing("Mylari", "Famous for its soft dosa.", "", "₹60"),)
    assert (found.lat, found.lng) == (12.30, 76.65)
    assert 6 * 24 * 3600 < fake_redis.ttl("guide:city:mysore") <= 7 * 24 * 3600


BENGALURU = """'''Bengaluru''' is the largest city in southern India.
==Districts==
{{Regionlist
| region1name=[[Bengaluru/South|South Bengaluru]]
| region2name=[[Bengaluru/West Central|West Central Bengaluru]]
| region3name=[[Bengaluru/South|the south again]]
}}
==See==
{{seeDistricts}}
==Do==
* {{do | name=Cinemax | content=A cinema. }}
==Eat==
{{seeDistricts}}
"""
SOUTH = """==See==
* {{see | name=Lalbagh Botanical Garden | wikidata=Q200711 | content=A glasshouse and old trees. }}
* {{see | name=Bull Temple | content= }}
==Eat==
* {{eat | name=Vidyarthi Bhavan | wikidata=Q7928218 | content=Crisp dosas since 1943. }}
"""
WEST_CENTRAL = """==See==
* {{see | name=Cubbon Park | wikidata=Q1144373 | content=The city's green lungs. }}
* {{see | name=Lalbagh Botanical Garden | wikidata=Q200711 | content=Listed twice. }}
==Do==
* {{do | name=Jawaharlal Nehru Planetarium | wikidata=Q6168372 | content=Shows in Kannada and English. }}
"""


def _bengaluru(districts: int = 200):
    def answer(request: httpx.Request) -> httpx.Response:
        if request.url.params["titles"] == "Bengaluru":
            return httpx.Response(200, json=_wikivoyage(_page("Bengaluru", BENGALURU, "Bengaluru is the largest city in southern India.")))
        if districts != 200:
            return httpx.Response(districts)
        # In another order than asked: the guide keeps the city guide's.
        return httpx.Response(200, json=_wikivoyage(_page("Bengaluru/West Central", WEST_CENTRAL), _page("Bengaluru/South", SOUTH)))

    return answer


def test_a_big_citys_guide_reads_its_district_guides_too(sources, fake_redis):
    seen: list[httpx.Request] = []
    found = asyncio.run(guide.city_guide("Bengaluru", client=_client(_bengaluru(), seen)))

    assert [r.url.params["titles"] for r in seen] == ["Bengaluru", "Bengaluru/South|Bengaluru/West Central"]
    assert seen[1].url.params["prop"] == "revisions"
    # A few from each district in turn, the better known first, each place once.
    assert [x.name for x in found.see] == ["Lalbagh Botanical Garden", "Cubbon Park", "Bull Temple"]
    assert [x.name for x in found.do] == ["Jawaharlal Nehru Planetarium", "Cinemax"]
    assert [x.name for x in found.eat] == ["Vidyarthi Bhavan"]
    assert fake_redis.ttl("guide:city:bengaluru") > 0

    # When the districts don't come, the city's own guide still answers, and it isn't kept.
    fake_redis.flushall()
    thin = asyncio.run(guide.city_guide("Bengaluru", client=_client(_bengaluru(districts=504), [])))
    assert thin.see == () and [x.name for x in thin.do] == ["Cinemax"]
    assert fake_redis.get("guide:city:bengaluru") is None


def test_no_guide_for_a_missing_page_and_nothing_kept_when_wikivoyage_fails(sources, fake_redis, monkeypatch):
    seen: list[httpx.Request] = []
    missing = _client(lambda r: httpx.Response(200, json=_wikivoyage({"ns": 0, "title": "Nowhereabad", "missing": True})), seen)
    assert asyncio.run(guide.city_guide("Nowhereabad", client=missing)) is None
    assert asyncio.run(guide.city_guide("Nowhereabad", client=missing)) is None
    assert len(seen) == 1 and 0 < fake_redis.ttl("guide:city:nowhereabad") <= 24 * 3600
    # A page listing the places of that name isn't a guide.
    several = _client(lambda r: httpx.Response(200, json=_wikivoyage(_page("Aurangabad", "{{disamb}}\n'''Aurangabad''' may be:"))), seen)
    assert asyncio.run(guide.city_guide("Aurangabad", client=several)) is None

    # Busy: nothing kept, and Wikivoyage is left alone as long as it asks.
    seen.clear()
    busy = _client(lambda r: httpx.Response(503, headers={"retry-after": "120"}), seen)
    assert asyncio.run(guide.city_guide("Mysuru", client=busy)) is None
    assert asyncio.run(guide.city_guide("Mysuru", client=busy)) is None
    assert len(seen) == 1 and fake_redis.get("guide:city:mysuru") is None
    assert 60 < fake_redis.ttl("guide:rest:en.wikivoyage.org") <= 120

    # No answer in time, or one it can't read: nothing, never an error.
    fake_redis.flushall()
    assert asyncio.run(guide.city_guide("Mysuru", client=_client(_down, []))) is None
    assert 0 < fake_redis.ttl("guide:rest:en.wikivoyage.org") <= 60
    fake_redis.flushall()
    assert asyncio.run(guide.city_guide("Mysuru", client=_client(lambda r: httpx.Response(200, text="<html>busy</html>"), []))) is None

    # Switched off: not asked at all.
    monkeypatch.setattr(get_settings(), "wikivoyage_url", "")
    seen.clear()
    assert asyncio.run(guide.city_guide("Mysuru", client=_client(lambda r: httpx.Response(200), seen))) is None and seen == []


def test_a_guide_answers_without_redis_too(sources, monkeypatch):
    class Down:
        def __getattr__(self, name):
            def fail(*args, **kwargs):
                raise redis.ConnectionError("down")

            return fail

    monkeypatch.setattr(guide, "get_redis", Down)
    seen: list[httpx.Request] = []
    client = _client(lambda r: httpx.Response(200, json=_wikivoyage(_page("Mysuru", MYSURU, EXTRACT))), seen)
    assert asyncio.run(guide.city_guide("Mysuru", client=client)).title == "Mysuru"
    assert asyncio.run(guide.city_guide("Mysuru", client=client)).title == "Mysuru"
    assert len(seen) == 2  # nothing kept, so asked again


# ---------- OpenStreetMap, through Overpass ----------

#: Lalbagh's gate: Overpass is asked about 12.95, 77.58.
LAT, LNG = 12.9507, 77.5848


def _node(name: str | None, lat: float, lng: float, **tags: str) -> dict:
    return {"type": "node", "id": 1, "lat": lat, "lon": lng, "tags": {**({"name": name} if name else {}), **tags}}


def _way(name: str, lat: float, lng: float, **tags: str) -> dict:
    """A building or a park: Overpass gives its centre."""
    return {"type": "way", "id": 2, "center": {"lat": lat, "lon": lng}, "tags": {"name": name, **tags}}


def _overpass(*elements: dict) -> dict:
    return {"version": 0.6, "generator": "Overpass API", "elements": list(elements)}


SIGHTS = [
    _node("Lalbagh Glass House", LAT, LNG, tourism="attraction", wikidata="Q3536567"),
    _way("Tipu Sultan's Summer Palace", 12.9593, 77.5737, historic="palace", tourism="attraction", wikipedia="en:Tipu Sultan's Summer Palace"),
    _node("ಬಸವನಗುಡಿ ನಂದಿ", 12.9427, 77.5681, **{"name:en": "Bull Temple", "tourism": "attraction"}),
    _node("Lalbagh Glass House", 12.9600, 77.5900, tourism="attraction"),  # the same name further off
    _node(None, 12.9510, 77.5850, tourism="viewpoint"),
    {"type": "way", "id": 3, "tags": {"name": "No centre", "tourism": "museum"}},
    _node("Too far", 12.9990, 77.5848, tourism="museum"),  # 5.3 km north: Overpass looked further, the guide doesn't
    *(_node(f"Sight {i}", LAT + i * 0.0015, LNG, tourism="museum") for i in range(1, 26)),
]


def test_places_near_asks_overpass_for_the_area_and_keeps_named_places_nearest_first(sources, fake_redis):
    seen: list[httpx.Request] = []
    client = _client(lambda r: httpx.Response(200, json=_overpass(*SIGHTS)), seen)

    found = asyncio.run(guide.places_near(LAT, LNG, "see", client=client))

    (request,) = seen
    assert request.method == "POST" and request.headers["user-agent"] == "Reroute/1.0 (travel planner)"
    query = parse_qs(request.content.decode())["data"][0]
    # Only the area goes out: the point rounded to about a kilometre, looked around that much further.
    assert query == (
        "[out:json][timeout:8];("
        'nwr(around:5800,12.95,77.58)["tourism"~"^(attraction|museum|viewpoint|gallery)$"]["name"];'
        'nwr(around:5800,12.95,77.58)["historic"~"^(monument|fort|palace|memorial)$"]["name"];'
        ");out center 100;"
    )
    assert len(found) == 20 and [s.metres for s in found] == sorted(s.metres for s in found)
    assert found[0] == guide.Sight("Lalbagh Glass House", "sight", LAT, LNG, 0, True)
    palace = next(s for s in found if s.name == "Tipu Sultan's Summer Palace")
    assert palace.what == "palace" and palace.notable and 1400 < palace.metres < 1600
    assert any(s.name == "Bull Temple" for s in found)
    assert all(s.name not in ("No centre", "Too far") for s in found)
    assert sum(s.name == "Lalbagh Glass House" for s in found) == 1

    # Kept a day for the area: another point nearby needs no call, and its distances are its own.
    assert 23 * 3600 < fake_redis.ttl("guide:near:see:12.95,77.58") <= 24 * 3600
    nearby = asyncio.run(guide.places_near(12.9480, 77.5820, "see", client=client))
    assert len(seen) == 1 and nearby[0].name == "Lalbagh Glass House" and nearby[0].metres > 0


def test_places_to_eat_are_close_by_and_say_their_food(sources):
    restaurants = [
        _node("Vidyarthi Bhavan", 12.9452, 77.5800, amenity="restaurant", cuisine="south_indian;coffee_shop"),
        _node("Brahmin's Coffee Bar", 12.9500, 77.5850, amenity="cafe"),
        _node("Across town", 12.9750, 77.5848, amenity="restaurant"),  # 2.7 km: too far for a meal
    ]
    seen: list[httpx.Request] = []
    found = asyncio.run(guide.places_near(LAT, LNG, "eat", client=_client(lambda r: httpx.Response(200, json=_overpass(*restaurants)), seen)))
    assert 'nwr(around:2300,12.95,77.58)["amenity"~"^(restaurant|cafe)$"]["name"];' in parse_qs(seen[0].content.decode())["data"][0]
    assert [(s.name, s.what) for s in found] == [("Brahmin's Coffee Bar", "cafe"), ("Vidyarthi Bhavan", "restaurant, south indian")]


def test_places_near_gives_nothing_while_overpass_is_busy_and_keeps_nothing(sources, fake_redis, monkeypatch):
    seen: list[httpx.Request] = []
    busy = _client(lambda r: httpx.Response(429, text="Too Many Requests", headers={"retry-after": "120"}), seen)
    assert asyncio.run(guide.places_near(LAT, LNG, "do", client=busy)) == []
    assert asyncio.run(guide.places_near(LAT, LNG, "do", client=busy)) == []
    assert len(seen) == 1 and 60 < fake_redis.ttl("guide:rest:overpass-api.de") <= 120
    assert fake_redis.get("guide:near:do:12.95,77.58") is None

    # A search Overpass couldn't finish isn't "nothing here": it isn't kept.
    fake_redis.flushall()
    timed_out = {**_overpass(*SIGHTS[:2]), "remark": 'runtime error: Query timed out in "query" at line 1 after 9 seconds.'}
    assert asyncio.run(guide.places_near(LAT, LNG, "see", client=_client(lambda r: httpx.Response(200, json=timed_out), []))) == []
    assert fake_redis.get("guide:near:see:12.95,77.58") is None
    assert asyncio.run(guide.places_near(LAT, LNG, "see", client=_client(_down, []))) == []

    # A kind it doesn't know, or Overpass switched off: not asked.
    seen.clear()
    assert asyncio.run(guide.places_near(LAT, LNG, "shop", client=_client(lambda r: httpx.Response(200), seen))) == []
    monkeypatch.setattr(get_settings(), "overpass_url", "")
    assert asyncio.run(guide.places_near(LAT, LNG, "see", client=_client(lambda r: httpx.Response(200), seen))) == [] and seen == []


# ---------- the web, through Gemini with Google Search ----------

QUESTION = "When is Lalbagh Botanical Garden in Bengaluru open, and what does entry cost?"


@pytest.fixture
def helper(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ai_helper_enabled", True)
    monkeypatch.setattr(s, "gemini_api_key", "test-key")
    monkeypatch.setattr(s, "roo_agent_model", "gemini-3.5-flash")
    monkeypatch.setattr(s, "gemini_model", "gemini-3.5-flash-lite")


def _grounded(request: httpx.Request) -> httpx.Response:
    chunks = [{"web": {"uri": f"https://vertexaisearch.cloud.google.com/grounding-api-redirect/{i}", "title": f"site{i}.in"}} for i in range(4)]
    return httpx.Response(
        200,
        json={
            "candidates": [
                {
                    "content": {"parts": [{"text": "Thinking about it", "thought": True}, {"text": "Lalbagh is open 6 AM to 7 PM, and entry is ₹30."}]},
                    "groundingMetadata": {"webSearchQueries": ["lalbagh timings"], "groundingChunks": [chunks[0], chunks[0], *chunks[1:]]},
                }
            ]
        },
    )


def test_a_web_answer_is_grounded_in_google_search_with_up_to_three_sources(helper, fake_redis):
    seen: list[httpx.Request] = []
    found = asyncio.run(guide.web_answer(QUESTION, client=_client(_grounded, seen)))
    again = asyncio.run(guide.web_answer(f"  {QUESTION.lower()} ", client=_client(_grounded, seen)))

    assert found == again and len(seen) == 1
    assert found.text == "Lalbagh is open 6 AM to 7 PM, and entry is ₹30."
    assert [x.title for x in found.sources] == ["site0.in", "site1.in", "site2.in"]
    assert found.sources[0].url == "https://vertexaisearch.cloud.google.com/grounding-api-redirect/0"
    (request,) = seen
    assert request.url.path.endswith("/models/gemini-3.5-flash:generateContent")
    assert request.headers["x-goog-api-key"] == "test-key" and "test-key" not in str(request.url)
    body = json.loads(request.content)
    assert body["tools"] == [{"google_search": {}}] and body["contents"][0]["parts"][0]["text"] == QUESTION
    (key,) = fake_redis.scan_iter("guide:web:*")
    assert 0 < fake_redis.ttl(key) <= 3600


def test_web_answers_need_the_ai_helper_and_a_key_and_rest_a_model_out_of_quota(helper, fake_redis, monkeypatch):
    s = get_settings()
    seen: list[httpx.Request] = []

    monkeypatch.setattr(s, "ai_helper_enabled", False)
    assert asyncio.run(guide.web_answer(QUESTION, client=_client(_grounded, seen))) is None
    monkeypatch.setattr(s, "ai_helper_enabled", True)
    monkeypatch.setattr(s, "gemini_api_key", "")
    assert asyncio.run(guide.web_answer(QUESTION, client=_client(_grounded, seen))) is None
    assert seen == []
    monkeypatch.setattr(s, "gemini_api_key", "test-key")

    # Rico's model has used up its quota for the day: it rests as long as Gemini says, and the helper's answers.
    daily = {"error": {"code": 429, "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "76530s"}]}}

    def quota(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json=daily) if "gemini-3.5-flash:" in request.url.path else _grounded(request)

    assert asyncio.run(guide.web_answer(QUESTION, client=_client(quota, seen))).text.startswith("Lalbagh is open")
    assert [r.url.path.rsplit("/", 1)[-1] for r in seen] == ["gemini-3.5-flash:generateContent", "gemini-3.5-flash-lite:generateContent"]
    assert 76_000 < fake_redis.ttl("guide:web:rest:gemini-3.5-flash") <= 76_530
    # The agent's own rest counts too; with both resting, nothing is asked.
    seen.clear()
    fake_redis.set("roo:llm:cooldown:gemini-3.5-flash-lite", "1", ex=60)
    assert asyncio.run(guide.web_answer("Is Cubbon Park open on Mondays?", client=_client(quota, seen))) is None and seen == []

    # A failure is nothing, never an error, and isn't kept.
    fake_redis.flushall()
    assert asyncio.run(guide.web_answer("Is Cubbon Park open on Mondays?", client=_client(lambda r: httpx.Response(500), seen))) is None
    assert asyncio.run(guide.web_answer("Is Cubbon Park open on Mondays?", client=_client(_down, []))) is None
    empty = {"candidates": [{"content": {"parts": []}}]}
    assert asyncio.run(guide.web_answer("Is Cubbon Park open on Mondays?", client=_client(lambda r: httpx.Response(200, json=empty), []))) is None
    assert not list(fake_redis.scan_iter("guide:web:*"))
