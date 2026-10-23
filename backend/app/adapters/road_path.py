"""Real roads: routes along OpenStreetMap's roads from FOSSGIS's public OSRM servers (routing.openstreetmap.de,
car and foot), with turn-by-turn steps, and road distances between places.

For the map, the directions and rough estimates only: a planned leg's times and fares come from the
travel-time snapshot. FOSSGIS asks for light use, so:
- every answer is cached for 30 days, and "no road between these points" for a day;
- calls are spaced a second apart per server across every copy of the API, and a day's calls are capped;
- a server that answers 429 or fails is left alone for a while: as long as it asks, else 30 s, doubling up
  to 15 minutes. An outage is never cached: the same request is tried again later.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from dataclasses import asdict, dataclass
from datetime import date
from typing import Literal
from urllib.parse import urlparse

import httpx

from app.config import get_settings

LngLat = tuple[float, float]
Profile = Literal["car", "foot"]
CACHE_SECONDS = 30 * 24 * 3600
NO_ROUTE_SECONDS = 24 * 3600
BACKOFF_FIRST_SECONDS = 30
BACKOFF_MAX_SECONDS = 15 * 60
#: A step's line keeps a point only where it bends more than this many metres from a straight run.
SIMPLIFY_M = 2.0


class Unavailable(Exception):
    """Routing can't answer now (off, busy, failing, or over the day's limit): try again later."""


@dataclass(frozen=True)
class Step:
    """One manoeuvre (OSRM's): what to do where, then along which road and how far."""

    kind: str
    modifier: str
    name: str
    exit: int | None
    distance_m: int
    duration_s: int
    #: Index into the route's coords where the step starts.
    at: int


@dataclass(frozen=True)
class Route:
    coords: list[LngLat]
    distance_m: int
    duration_s: int
    steps: list[Step]


@dataclass(frozen=True)
class RoadPath:
    coords: list[LngLat]
    distance_m: int
    duration_s: int
    source: Literal["road", "line"]


def metres(a: LngLat, b: LngLat) -> float:
    dlat, dlng = math.radians(b[1] - a[1]), math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[1])) * math.cos(math.radians(b[1])) * math.sin(dlng / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def straight(a: LngLat, b: LngLat) -> RoadPath:
    return RoadPath(coords=[a, b], distance_m=round(metres(a, b)), duration_s=0, source="line")


def simplify(points: list[LngLat], tolerance_m: float = SIMPLIFY_M) -> list[LngLat]:
    """Douglas-Peucker on a local flat projection: the ends always stay."""
    if len(points) < 3:
        return points
    kx = 111_320 * math.cos(math.radians(points[0][1]))
    xy = [(p[0] * kx, p[1] * 110_540) for p in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        (ax, ay), (bx, by) = xy[first], xy[last]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy) or 1e-9
        far, worst = 0.0, -1
        for i in range(first + 1, last):
            d = abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / length
            if d > far:
                far, worst = d, i
        if worst > 0 and far > tolerance_m:
            keep[worst] = True
            stack += [(first, worst), (worst, last)]
    return [p for p, k in zip(points, keep, strict=True) if k]


def parse_route(route: dict) -> Route:
    """OSRM's route with steps as one line and its steps. Waypoints in between (a route through stands) aren't
    turns: their arrive and depart steps are dropped."""
    coords: list[LngLat] = []
    steps: list[Step] = []
    legs = route["legs"]
    for li, leg in enumerate(legs):
        for step in leg["steps"]:
            m = step["maneuver"]
            kind = m["type"]
            if (kind == "arrive" and li < len(legs) - 1) or (kind == "depart" and li > 0):
                continue
            line = simplify([(round(x, 5), round(y, 5)) for x, y in step["geometry"]["coordinates"]])
            # The step starts where the last one ended (its first point is already there).
            at = len(coords) - 1 if coords and line and coords[-1] == line[0] else len(coords)
            for point in line:
                if not coords or coords[-1] != point:
                    coords.append(point)
            name = step.get("name") or step.get("ref") or ""
            steps.append(Step(kind, m.get("modifier", ""), name, m.get("exit"), round(step["distance"]), round(step["duration"]), at))
    return Route(coords=coords, distance_m=round(route["distance"]), duration_s=round(route["duration"]), steps=steps)


def _to_json(route: Route) -> dict:
    return {"coords": route.coords, "distance_m": route.distance_m, "duration_s": route.duration_s, "steps": [asdict(s) for s in route.steps]}


def _from_json(data: dict) -> Route:
    return Route(
        coords=[tuple(c) for c in data["coords"]],  # type: ignore[misc]
        distance_m=data["distance_m"],
        duration_s=data["duration_s"],
        steps=[Step(**s) for s in data["steps"]],
    )


def _key(kind: str, profile: str, points: list[LngLat]) -> str:
    where = ";".join(f"{lng:.5f},{lat:.5f}" for lng, lat in points)
    return f"routing:{kind}:{profile}:" + hashlib.sha256(where.encode()).hexdigest()[:24]


class Router:
    def __init__(self, redis_client, client: httpx.Client | None = None):
        s = get_settings()
        self.redis = redis_client
        self.base: dict[str, str] = {"car": s.routing_car_url.rstrip("/"), "foot": s.routing_foot_url.rstrip("/")}
        # Made on the first call that needs it: most answers come from the cache, and a TLS client is slow to make.
        self._client = client
        self.user_agent = s.routing_user_agent
        self.interval_ms = s.routing_min_interval_ms
        self.daily_limit = s.routing_daily_limit
        #: Calls that went to a server (not the cache), so a job can keep to a budget.
        self.calls = 0

    def on(self, profile: Profile) -> bool:
        return bool(self.base[profile])

    def route(self, points: list[LngLat], profile: Profile) -> Route | None:
        """The road route through `points` in order; None when there's no road between them."""
        key = _key("route", profile, points)
        cached = self.redis.get(key)
        if cached is not None:
            data = json.loads(cached)
            return _from_json(data) if data else None
        where = ";".join(f"{lng:.6f},{lat:.6f}" for lng, lat in points)
        body = self._ask(
            profile, f"route/v1/{'foot' if profile == 'foot' else 'driving'}/{where}", {"overview": "false", "steps": "true", "geometries": "geojson"}
        )
        if body is None:
            self.redis.set(key, "null", ex=NO_ROUTE_SECONDS)
            return None
        route = parse_route(body["routes"][0])
        self.redis.set(key, json.dumps(_to_json(route)), ex=CACHE_SECONDS)
        return route

    def distances(self, points: list[LngLat], profile: Profile = "car") -> list[list[float | None]]:
        """Road metres from each point to each other (None where there's no road), in one request."""
        key = _key("table", profile, points)
        cached = self.redis.get(key)
        if cached is not None:
            return json.loads(cached)
        where = ";".join(f"{lng:.6f},{lat:.6f}" for lng, lat in points)
        body = self._ask(profile, f"table/v1/{'foot' if profile == 'foot' else 'driving'}/{where}", {"annotations": "distance"})
        table = body["distances"] if body else [[None] * len(points) for _ in points]
        self.redis.set(key, json.dumps(table), ex=CACHE_SECONDS if body else NO_ROUTE_SECONDS)
        return table

    def _ask(self, profile: Profile, path: str, params: dict) -> dict | None:
        """The server's answer; None for "no road there". Raises Unavailable when it can't answer now."""
        base = self.base[profile]
        if not base:
            raise Unavailable("routing is off")
        host = urlparse(base).netloc
        self._gate(host)
        self.calls += 1
        try:
            if self._client is None:
                self._client = httpx.Client(timeout=10.0)
            res = self._client.get(f"{base}/{path}", params=params, headers={"User-Agent": self.user_agent})
        except httpx.HTTPError as exc:
            self._back_off(host, None)
            raise Unavailable(f"{host} unreachable") from exc
        if res.status_code == 429 or res.status_code >= 500:
            self._back_off(host, res.headers.get("retry-after"))
            raise Unavailable(f"{host} answered {res.status_code}")
        try:
            body = res.json()
        except ValueError as exc:
            raise Unavailable(f"{host} sent no JSON") from exc
        if body.get("code") in ("NoRoute", "NoSegment", "NoTable"):
            return None
        if res.status_code != 200 or body.get("code") != "Ok":
            raise Unavailable(f"{host} answered {res.status_code} {body.get('code')}")
        self.redis.delete(f"routing:backoff-span:{host}")
        return body

    def _gate(self, host: str) -> None:
        """Wait for this server's next free second; refuse while it's resting or the day's calls are used."""
        r = self.redis
        if r.exists(f"routing:backoff:{host}"):
            raise Unavailable(f"leaving {host} alone for now")
        day = f"routing:count:{host}:{date.today().isoformat()}"
        used = r.incr(day)
        if used == 1:
            r.expire(day, 26 * 3600)
        if used > self.daily_limit:
            raise Unavailable(f"today's {self.daily_limit} calls to {host} are used")
        for _ in range(40):
            if r.set(f"routing:slot:{host}", "1", nx=True, px=self.interval_ms):
                return
            time.sleep(0.1)
        raise Unavailable(f"{host} is busy")

    def _back_off(self, host: str, retry_after: str | None) -> None:
        span = int(self.redis.get(f"routing:backoff-span:{host}") or 0)
        span = min(BACKOFF_MAX_SECONDS, span * 2 if span else BACKOFF_FIRST_SECONDS)
        wait = int(retry_after) if retry_after and retry_after.isdigit() else span
        self.redis.set(f"routing:backoff:{host}", "1", ex=max(1, min(BACKOFF_MAX_SECONDS, wait)))
        self.redis.set(f"routing:backoff-span:{host}", span, ex=24 * 3600)


class RoadPaths:
    """A leg's line along the roads for `GET /v1/road-path`: the route, or a straight line marked as such."""

    def __init__(self, redis_client, client: httpx.Client | None = None):
        self.router = Router(redis_client, client)

    def get(self, a: LngLat, b: LngLat, profile: Literal["driving", "foot"]) -> RoadPath:
        try:
            route = self.router.route([a, b], "foot" if profile == "foot" else "car")
        except Unavailable:
            route = None
        if route is None or len(route.coords) < 2:
            return straight(a, b)
        return RoadPath(coords=route.coords, distance_m=route.distance_m, duration_s=route.duration_s, source="road")
