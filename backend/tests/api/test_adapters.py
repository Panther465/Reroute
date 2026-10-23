"""Travel-time and transit adapters: OSRM with Raasta legs, caching, and falling back when a service is down."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from app.adapters.transit import RaastaHttpAdapter, RaastaLeg, RouteInfo, StaticTransitAdapter
from app.adapters.travel_times import OsrmSnapshotAdapter, PlacePoint, SampleSnapshotAdapter
from app.config import get_settings
from app.services.planner import Mode

DAY = date(2026, 10, 14)
KOR = PlacePoint("koramangala-bank", 77.6195, 12.9352)
JAY = PlacePoint("jayanagar-office", 77.5838, 12.9255)
WF = PlacePoint("whitefield-office", 77.7318, 12.9855)
#: A place found by search, which the sample travel data doesn't know: about 0.5 km from the bank.
CAFE = PlacePoint("osm-test-cafe", 77.6150, 12.9340)


FOSSGIS = json.loads((Path(__file__).parents[1] / "fixtures" / "fossgis_route_car.json").read_text(encoding="utf-8"))
HOTEL, BANK = (77.5713, 12.9767), (77.6185, 12.934)


def _router(fake_redis, monkeypatch, answer, seen: list[httpx.Request] | None = None, **settings):
    from app.adapters.road_path import Router

    s = get_settings()
    monkeypatch.setattr(s, "routing_car_url", "https://routing.openstreetmap.de/routed-car")
    monkeypatch.setattr(s, "routing_foot_url", "https://routing.openstreetmap.de/routed-foot")
    monkeypatch.setattr(s, "routing_min_interval_ms", 1)
    for name, value in settings.items():
        monkeypatch.setattr(s, name, value)

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return answer(request)

    return Router(fake_redis, client=httpx.Client(transport=httpx.MockTransport(handler)))


def test_routes_come_along_the_roads_with_their_turns_and_are_kept(fake_redis, monkeypatch):
    seen: list[httpx.Request] = []
    router = _router(fake_redis, monkeypatch, lambda r: httpx.Response(200, json=FOSSGIS), seen)
    route = router.route([HOTEL, BANK], "car")
    again = router.route([HOTEL, BANK], "car")

    assert route == again and len(seen) == 1 and router.calls == 1
    (request,) = seen
    assert request.url.path == "/routed-car/route/v1/driving/77.571300,12.976700;77.618500,12.934000"
    assert request.url.params["steps"] == "true"
    assert "Reroute" in request.headers["user-agent"]
    raw = FOSSGIS["routes"][0]["legs"][0]["steps"]
    assert route.distance_m == 9072 and len(route.steps) == len(raw)
    first, second, last = route.steps[0], route.steps[1], route.steps[-1]
    assert (first.kind, first.modifier, first.name, first.at) == ("depart", "left", "Gubbi Thotadappa Road", 0)
    assert (second.kind, second.modifier, second.name) == ("turn", "left", "Tank Bund Road")
    assert last.kind == "arrive" and last.at == len(route.coords) - 1
    # Each step starts where the road it describes does, and the line keeps only the bends that show.
    assert [s.at for s in route.steps] == sorted(s.at for s in route.steps)
    assert route.coords[second.at] == tuple(round(x, 5) for x in raw[1]["geometry"]["coordinates"][0])
    assert len(route.coords) < sum(len(x["geometry"]["coordinates"]) for x in raw)


def test_no_road_is_remembered_for_a_day_and_an_outage_not_at_all(fake_redis, monkeypatch):
    from app.adapters.road_path import Unavailable

    nowhere = _router(fake_redis, monkeypatch, lambda r: httpx.Response(400, json={"code": "NoRoute", "message": "Impossible route"}))
    assert nowhere.route([HOTEL, BANK], "foot") is None
    (key,) = fake_redis.scan_iter("routing:route:foot:*")
    assert 0 < fake_redis.ttl(key) <= 24 * 3600

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    router = _router(fake_redis, monkeypatch, down)
    with pytest.raises(Unavailable):
        router.route([HOTEL, BANK], "car")
    assert not list(fake_redis.scan_iter("routing:route:car:*"))
    # Left alone for 30 s, then twice as long after the next failure.
    assert 0 < fake_redis.ttl("routing:backoff:routing.openstreetmap.de") <= 30
    fake_redis.delete("routing:backoff:routing.openstreetmap.de")
    with pytest.raises(Unavailable):
        router.route([HOTEL, BANK], "car")
    assert 30 < fake_redis.ttl("routing:backoff:routing.openstreetmap.de") <= 60


def test_a_busy_server_is_left_alone_as_long_as_it_asks_and_a_day_has_a_cap(fake_redis, monkeypatch):
    from app.adapters.road_path import Unavailable

    seen: list[httpx.Request] = []
    busy = _router(fake_redis, monkeypatch, lambda r: httpx.Response(429, headers={"retry-after": "120"}), seen)
    with pytest.raises(Unavailable):
        busy.route([HOTEL, BANK], "car")
    with pytest.raises(Unavailable):
        busy.route([HOTEL, BANK], "car")
    assert len(seen) == 1 and 60 < fake_redis.ttl("routing:backoff:routing.openstreetmap.de") <= 120

    fake_redis.flushall()
    capped = _router(fake_redis, monkeypatch, lambda r: httpx.Response(200, json=FOSSGIS), routing_daily_limit=1)
    capped.route([HOTEL, BANK], "car")
    with pytest.raises(Unavailable, match="today"):
        capped.route([BANK, HOTEL], "car")


def test_road_paths_fall_back_to_a_straight_line(fake_redis, monkeypatch):
    from app.adapters.road_path import RoadPaths

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(get_settings(), "routing_foot_url", "https://routing.openstreetmap.de/routed-foot")
    path = RoadPaths(fake_redis, client=httpx.Client(transport=httpx.MockTransport(down))).get((KOR.lng, KOR.lat), (JAY.lng, JAY.lat), "foot")
    assert path.source == "line" and path.coords == [(KOR.lng, KOR.lat), (JAY.lng, JAY.lat)]
    assert 3800 < path.distance_m < 4100  # about 3.9 km as the crow flies


def test_a_city_without_sample_data_is_estimated_from_road_distances(fake_redis, monkeypatch):
    rajpura = [PlacePoint("osm-hotel", 76.5946, 30.4840), PlacePoint("osm-campus", 76.6577, 30.5165)]
    table = {"code": "Ok", "distances": [[0, 9000], [9400, 0]]}
    router = _router(fake_redis, monkeypatch, lambda r: httpx.Response(200, json=table))
    pairs = SampleSnapshotAdapter(StaticTransitAdapter({}), router=router).snapshot("rajpura", rajpura, DAY).lookup()
    (there,) = pairs[("osm-hotel", "osm-campus")]
    (back,) = pairs[("osm-campus", "osm-hotel")]
    # 9 km of road at 18 km/h is 30 minutes, plus 5 for the pickup; the fare is 100 + 20 a km.
    assert there.rough and there.travel_min == 35 and there.fare_inr == 280
    assert back.travel_min == 37  # 9.4 km back: the roads aren't the same both ways
    # Routing off: the straight line times 1.3, as before.
    plain = SampleSnapshotAdapter(StaticTransitAdapter({})).snapshot("rajpura", rajpura, DAY).lookup()
    assert plain[("osm-hotel", "osm-campus")][0].travel_min != 35


def test_sample_snapshot_estimates_places_it_does_not_know():
    pairs = SampleSnapshotAdapter(StaticTransitAdapter({})).snapshot("bengaluru", [KOR, JAY, CAFE], DAY).lookup()
    # Pairs the file has stay as the file says.
    assert pairs[(KOR.place_id, JAY.place_id)] and not any(o.rough for o in pairs[(KOR.place_id, JAY.place_id)])
    # Close by: a rough cab and a rough walk, both ways.
    for pair in ((KOR.place_id, CAFE.place_id), (CAFE.place_id, KOR.place_id)):
        assert {o.mode for o in pairs[pair]} == {Mode.CAB, Mode.WALK} and all(o.rough for o in pairs[pair])
    # About 3.5 km away: a cab only, priced from the fare table (about 4.6 km of road at 18 km/h, plus pickup).
    far = pairs[(JAY.place_id, CAFE.place_id)]
    assert [o.mode for o in far] == [Mode.CAB]
    assert far[0].rough and far[0].travel_min == 16 + 5 and far[0].fare_inr == 191


def test_gaps_between_known_places_stay_gaps():
    # The file has Whitefield to Koramangala but not back: no estimate fills it, so the demo day is unchanged.
    pairs = SampleSnapshotAdapter(StaticTransitAdapter({})).snapshot("bengaluru", [KOR, WF], DAY).lookup()
    assert (WF.place_id, KOR.place_id) in pairs
    assert (KOR.place_id, WF.place_id) not in pairs


def _osrm(calls: list[str]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        # 2 places: 12 min / 6 km by car, 70 min by foot.
        return httpx.Response(200, json={"durations": [[0, 720], [720, 0]], "distances": [[0, 6000], [6000, 0]]})

    return httpx.Client(transport=httpx.MockTransport(handler))


def _leg(status: str = "verified") -> RaastaLeg:
    return RaastaLeg(
        route_id="sample-kor-jay",
        vehicle_type="shared_auto",
        status=status,
        fare_inr=30,
        first_trip="07:00",
        last_trip="21:30",
        walk_from_min=3,
        walk_to_min=4,
        wait_min=5,
        ride_min=28,
    )


def test_osrm_snapshot_includes_cabs_and_raasta_legs(fake_redis):
    transit = StaticTransitAdapter({}, {(KOR.place_id, JAY.place_id): [_leg()]})
    calls: list[str] = []
    snap = OsrmSnapshotAdapter(transit, fake_redis, client=_osrm(calls)).snapshot("bengaluru", [KOR, JAY], DAY)
    there = next(p for p in snap.pairs if p.from_place == KOR.place_id)
    modes = {o.mode for o in there.options}
    assert Mode.CAB in modes and Mode.SHARED_AUTO in modes
    auto = next(o for o in there.options if o.mode is Mode.SHARED_AUTO)
    assert auto.travel_min == 3 + 5 + 28 + 4
    assert auto.fare_inr == 30
    assert (auto.service_first, auto.service_last) == (7 * 60, 21 * 60 + 30)
    assert auto.transit_ref is not None and auto.transit_ref.status == "verified"
    cab = next(o for o in there.options if o.mode is Mode.CAB)
    assert cab.travel_min == 12 + 5  # drive plus pickup


def test_osrm_tables_are_cached(fake_redis):
    calls: list[str] = []
    adapter = OsrmSnapshotAdapter(StaticTransitAdapter({}), fake_redis, client=_osrm(calls))
    adapter.snapshot("bengaluru", [KOR, JAY], DAY)
    adapter.snapshot("bengaluru", [KOR, JAY], DAY)
    assert len(calls) == 2  # car and foot once, then from the cache


def test_osrm_outage_falls_back_to_the_sample_snapshot(fake_redis):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    adapter = OsrmSnapshotAdapter(StaticTransitAdapter({}), fake_redis, client=httpx.Client(transport=httpx.MockTransport(down)))
    snap = adapter.snapshot("bengaluru", [KOR, JAY], DAY)
    assert snap.snapshot_id.startswith("blr-sample")
    assert any(p.from_place == KOR.place_id and p.to_place == JAY.place_id for p in snap.pairs)


def test_raasta_answers_are_cached(fake_redis):
    hits: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hits.append(request.url.path)
        return httpx.Response(200, json={"status": "verified", "firstTrip": "07:00", "lastTrip": "21:30", "fareInr": 30, "frequencyMin": 10})

    adapter = RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(handler)), redis_client=fake_redis)
    first = adapter.routes(["sample-kor-jay"])
    second = adapter.routes(["sample-kor-jay"])
    assert first == second == {"sample-kor-jay": RouteInfo("sample-kor-jay", "verified", "07:00", "21:30", 30, 10)}
    assert len(hits) == 1


def test_raasta_leg_options_estimate_the_ride(fake_redis):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["at"].startswith("2026-10-14T00:05")
        item = {
            "routeId": "sample-kor-jay",
            "vehicleType": "shared_auto",
            "status": "verified",
            "fareInr": 30,
            "firstTrip": "07:00",
            "lastTrip": "21:30",
            "walkFromMin": 3,
            "walkToMin": 4,
            "expectedWaitMin": 5,
            "rideDistanceM": 5000,
        }
        return httpx.Response(200, json={"items": [item], "extras": [], "lastTripPassed": []})

    adapter = RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(handler)), redis_client=fake_redis)
    legs = adapter.leg_options(KOR, JAY, DAY, "+05:30")
    assert [(x.route_id, x.ride_min, x.travel_min) for x in legs] == [("sample-kor-jay", 20, 3 + 5 + 20 + 4)]
    cached = [json.loads(fake_redis.get(k)) for k in fake_redis.scan_iter("raasta:legs:*")]
    assert cached and cached[0][0]["route_id"] == "sample-kor-jay"


def test_raasta_unreachable_means_no_raasta_legs(fake_redis):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    adapter = RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(down)), redis_client=fake_redis)
    assert adapter.leg_options(KOR, JAY, DAY, "+05:30") == []
    assert adapter.routes(["sample-kor-jay"]) == {}


ROUTE = {"status": "verified", "firstTrip": "07:00", "lastTrip": "21:30", "fareInr": 30, "frequencyMin": 10}
LEG = {
    "routeId": "sample-kor-jay",
    "vehicleType": "shared_auto",
    "status": "verified",
    "fareInr": 30,
    "firstTrip": "07:00",
    "lastTrip": "21:30",
    "walkFromMin": 3,
    "walkToMin": 4,
    "expectedWaitMin": 5,
    "rideDistanceM": 5000,
}


class FlakyRaasta:
    """Answers well until told otherwise; counts the calls and keeps the service token it was sent."""

    def __init__(self):
        self.answer: httpx.Response | Exception | None = None
        self.calls = 0
        self.tokens: list[str | None] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        self.tokens.append(request.headers.get("x-service-token"))
        if isinstance(self.answer, Exception):
            raise self.answer
        if self.answer is not None:
            return self.answer
        return httpx.Response(200, json=ROUTE if "/routes/" in request.url.path else {"items": [LEG], "extras": []})

    def adapter(self, redis, token: str | None = ""):
        return RaastaHttpAdapter("http://raasta", client=httpx.Client(transport=httpx.MockTransport(self)), redis_client=redis, service_token=token)


def test_raasta_calls_carry_the_service_token(fake_redis):
    raasta = FlakyRaasta()
    raasta.adapter(fake_redis, "s" * 40).routes(["sample-kor-jay"])
    raasta.adapter(None, "").routes(["sample-kor-jay"])
    assert raasta.tokens == ["s" * 40, None]


def test_a_failing_raasta_falls_back_to_the_last_good_answer(fake_redis):
    raasta = FlakyRaasta()
    adapter = raasta.adapter(fake_redis)
    good_routes, good_legs = adapter.routes(["sample-kor-jay"]), adapter.leg_options(KOR, JAY, DAY, "+05:30")
    # The few-minute cache ran out and Raasta now fails: the routes stay verified, the legs stay offered.
    for name in ("raasta:route:sample-kor-jay", *[k for k in fake_redis.scan_iter("raasta:legs:*") if not k.endswith(":good")]):
        fake_redis.delete(name)
    raasta.answer = httpx.Response(503)
    assert adapter.routes(["sample-kor-jay"]) == good_routes and good_routes["sample-kor-jay"].status == "verified"
    assert adapter.leg_options(KOR, JAY, DAY, "+05:30") == good_legs


def test_raasta_saying_retry_after_is_left_alone_until_then(fake_redis):
    raasta = FlakyRaasta()
    adapter = raasta.adapter(fake_redis)
    raasta.answer = httpx.Response(429, headers={"Retry-After": "120"})
    assert adapter.routes(["sample-kor-jay"]) == {}
    assert 110 < fake_redis.ttl("raasta:backoff") <= 120
    calls = raasta.calls
    adapter.routes(["sample-kor-jay"])
    adapter.leg_options(KOR, JAY, DAY, "+05:30")
    assert raasta.calls == calls  # not asked again while backing off


def test_raasta_unreachable_backs_off_and_uses_the_last_good_legs(fake_redis):
    raasta = FlakyRaasta()
    adapter = raasta.adapter(fake_redis)
    good = adapter.leg_options(KOR, JAY, DAY, "+05:30")
    for name in [k for k in fake_redis.scan_iter("raasta:legs:*") if not k.endswith(":good")]:
        fake_redis.delete(name)
    raasta.answer = httpx.ConnectError("refused")
    assert adapter.leg_options(KOR, JAY, DAY, "+05:30") == good
    assert fake_redis.exists("raasta:backoff")


def test_only_a_404_makes_a_route_unverified(fake_redis):
    raasta = FlakyRaasta()
    adapter = raasta.adapter(fake_redis)
    adapter.routes(["sample-kor-jay"])
    fake_redis.delete("raasta:route:sample-kor-jay")
    raasta.answer = httpx.Response(404, json={"error": {"code": "NOT_FOUND"}})
    assert adapter.routes(["sample-kor-jay"]) == {}
    # Raasta said it doesn't know the route: the last good answer is forgotten, not used.
    assert not fake_redis.exists("raasta:route:sample-kor-jay:good") and not fake_redis.exists("raasta:backoff")


# ---------- Roo's voice: word timings for the mouth ----------


class _TimedVoice:
    """edge-tts without the network: two words, a comma, and a little audio (48 kbps: 6 bytes a ms)."""

    calls: list[str] = []

    def __init__(self, text, voice, rate, boundary="SentenceBoundary"):
        _TimedVoice.calls.append(boundary)

    async def stream(self):
        yield {"type": "WordBoundary", "offset": 500_000, "duration": 2_100_000, "text": "Time"}
        yield {"type": "WordBoundary", "offset": 2_700_000, "duration": 100_000, "text": ","}
        yield {"type": "WordBoundary", "offset": 3_000_000, "duration": 1_400_000, "text": "Roo"}
        yield {"type": "audio", "data": b"x" * 600}


def test_word_timings_come_in_milliseconds_without_punctuation():
    from app.adapters.tts import Word, words_from_chunks

    chunks = [
        {"type": "WordBoundary", "offset": 500_000, "duration": 2_100_000, "text": "Time"},
        {"type": "WordBoundary", "offset": 2_700_000, "duration": 100_000, "text": ","},
        {"type": "SentenceBoundary", "offset": 0, "duration": 9, "text": "Time, Roo"},
    ]
    assert words_from_chunks(chunks) == (Word("Time", 50, 210),)


def test_a_timed_clip_is_cached_with_its_words_and_old_audio_is_made_again(fake_redis, monkeypatch):
    import asyncio

    import edge_tts

    from app.adapters import tts
    from app.redis_client import get_redis_bytes

    _TimedVoice.calls = []
    monkeypatch.setattr(edge_tts, "Communicate", _TimedVoice)
    raw = get_redis_bytes()
    # Audio cached before timings existed: fine for /v1/speech, made again when the words are wanted.
    raw.set(tts.cache_key("Time, Roo", "en-IN-NeerjaNeural", "normal"), b"old-audio")
    assert asyncio.run(tts.synthesize("Time, Roo", "en-IN-NeerjaNeural", "normal", raw)).audio == b"old-audio"
    clip = asyncio.run(tts.synthesize("Time, Roo", "en-IN-NeerjaNeural", "normal", raw, need_words=True))
    assert [(w.text, w.offset_ms, w.duration_ms) for w in clip.words] == [("Time", 50, 210), ("Roo", 300, 140)]
    assert clip.duration_ms == 100 and not clip.cached and _TimedVoice.calls == ["WordBoundary"]
    again = asyncio.run(tts.synthesize("Time, Roo", "en-IN-NeerjaNeural", "normal", raw, need_words=True))
    assert again.cached and again.words == clip.words and _TimedVoice.calls == ["WordBoundary"]


def test_a_route_nobody_recorded_has_no_path_to_draw(fake_redis):
    stands = [
        {"name": "Koramangala 5th Block stand", "seq": 1, "location": {"lng": 77.6185, "lat": 12.934}},
        {"name": "Forum Mall", "seq": 2, "location": {"lng": 77.6112, "lat": 12.9346}},
    ]
    traced = [{"lng": 77.6185, "lat": 12.934}, {"lng": 77.615, "lat": 12.9338}, {"lng": 77.6112, "lat": 12.9346}]
    answers = {
        "/v1/raasta/routes/plain": {"vehicleType": "shared_auto", "stands": stands, "path": [s["location"] for s in stands]},
        "/v1/raasta/routes/traced": {"vehicleType": "shared_auto", "stands": stands, "path": traced},
    }
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=answers[r.url.path])))
    raasta = RaastaHttpAdapter(base_url="http://raasta.test", client=client, redis_client=fake_redis)
    # Raasta sends the stands as the path of a route nobody has recorded: drawn along the roads instead.
    plain = raasta.route_shape("plain")
    assert plain is not None and plain.path == [] and [s[0] for s in plain.stands] == ["Koramangala 5th Block stand", "Forum Mall"]
    assert raasta.route_shape("traced").path == [(p["lng"], p["lat"]) for p in traced]
