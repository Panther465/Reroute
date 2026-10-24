"""Rico as a local guide: what to see, do and eat in a city, from free sources.

- Wikivoyage's city guides, through the MediaWiki API: a short summary and a few named places from each guide's
  See, Do and Eat. A big city's guide lists its places in district guides, which are read too.
- OpenStreetMap's places near a point, through Overpass: sights, things to do and places to eat, with names.
  Only the area goes out, the point rounded to about a kilometre; distances are worked out here.
- An answer from the web: Gemini with Google Search, with up to 3 of the pages it read. Only with the AI helper
  on and a Gemini key.

Answers are kept in Redis: a city's guide 7 days, places near a point a day, a web answer an hour. A source that
fails or says it's busy is left alone for a minute (or as long as it asks), and nothing it said is kept. Nothing
here raises: a source that can't answer gives nothing, and Rico says so.
"""

from __future__ import annotations

import contextlib
import hashlib
import html
import json
import logging
import re
from dataclasses import asdict, dataclass
from itertools import zip_longest
from typing import Any
from urllib.parse import urlparse

import httpx
import redis

from app.adapters.llm import _COOLDOWN_KEY, GEMINI_URL, _wait_seconds
from app.adapters.road_path import metres
from app.config import get_settings
from app.redis_client import get_redis

log = logging.getLogger("reroute.guide")

#: Wikimedia and Overpass ask every caller to say who it is.
USER_AGENT = "Reroute/1.0 (travel planner)"
#: Each source gets this long; Rico's whole message has about 30 seconds.
WIKIVOYAGE_TIMEOUT = httpx.Timeout(8.0, connect=4.0)
OVERPASS_TIMEOUT = httpx.Timeout(10.0, connect=4.0)
SEARCH_TIMEOUT = httpx.Timeout(15.0, connect=4.0)
GUIDE_SECONDS = 7 * 24 * 3600
#: "Wikivoyage has no guide to that" is kept a day: a guide may be written.
NO_GUIDE_SECONDS = 24 * 3600
PLACES_SECONDS = 24 * 3600
WEB_SECONDS = 3600
#: A source that fails or says it's busy is left alone this long, or as long as it asks (at most 15 minutes).
REST_SECONDS = 60
LONGEST_REST = 15 * 60
_REST_KEY = "guide:rest:"
#: Set per model when Google Search's quota for it is used up: look-ups leave that model alone until it expires.
SEARCH_REST_KEY = "guide:web:rest:"

# ---------- what comes back ----------


@dataclass(frozen=True)
class Listing:
    """A place a city's guide names, with its first line about it, and its hours and price when it gives them."""

    name: str
    about: str = ""
    hours: str = ""
    price: str = ""
    #: It has a Wikidata entry: better known.
    notable: bool = False


@dataclass(frozen=True)
class CityGuide:
    title: str
    summary: str
    see: tuple[Listing, ...] = ()
    do: tuple[Listing, ...] = ()
    eat: tuple[Listing, ...] = ()
    #: The city's centre, as the guide's map gives it.
    lat: float | None = None
    lng: float | None = None


@dataclass(frozen=True)
class Sight:
    """A named place in OpenStreetMap and how far it is from the point asked about."""

    name: str
    #: What it is: "museum", "fort", "park", "restaurant, south indian".
    what: str
    lat: float
    lng: float
    metres: int
    #: It has a Wikipedia or Wikidata entry: better known.
    notable: bool = False


@dataclass(frozen=True)
class Source:
    title: str
    url: str


@dataclass(frozen=True)
class WebAnswer:
    text: str
    sources: tuple[Source, ...] = ()


# ---------- the cache, and leaving a source alone ----------


def _cached(key: str) -> str | None:
    try:
        return get_redis().get(key)
    except redis.RedisError:
        return None


def _keep(key: str, value: str, seconds: int) -> None:
    with contextlib.suppress(redis.RedisError):
        get_redis().set(key, value, ex=seconds)


def _resting(host: str) -> bool:
    try:
        return bool(get_redis().exists(_REST_KEY + host))
    except redis.RedisError:
        return False


def _rest(host: str, retry_after: str | None) -> None:
    wait = min(LONGEST_REST, int(retry_after)) if retry_after and retry_after.isdigit() else REST_SECONDS
    _keep(_REST_KEY + host, "1", max(1, wait))


async def _call(source: str, method: str, url: str, timeout: httpx.Timeout, client: httpx.AsyncClient | None, **kw: Any) -> httpx.Response | None:
    """The source's answer; None when it's resting, doesn't answer in time or says no. A failure rests it."""
    host = urlparse(url).netloc
    if _resting(host):
        return None
    headers = {"User-Agent": USER_AGENT}
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=timeout, headers=headers) as own:
                res = await own.request(method, url, **kw)
        else:
            res = await client.request(method, url, headers=headers, timeout=timeout, **kw)
    except httpx.HTTPError as exc:
        log.warning("%s didn't answer (%s); leaving it alone for a while", source, type(exc).__name__)
        _rest(host, None)
        return None
    if res.status_code == 429 or res.status_code >= 500:
        log.warning("%s answered %s; leaving it alone for a while", source, res.status_code)
        _rest(host, res.headers.get("retry-after"))
        return None
    if res.status_code != 200:
        log.warning("%s answered %s", source, res.status_code)
        return None
    return res


def _clip(text: str, most: int) -> str:
    """At most `most` characters, cut at a word."""
    text = " ".join(text.split())
    if len(text) <= most:
        return text
    return text[: most - 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def _sentences(text: str, most: int, count: int) -> str:
    """Up to `count` whole sentences from the start, as many as fit in `most` characters (the first, clipped, at least)."""
    out = ""
    for sentence in re.split(r"(?<=[.!?])\s+", " ".join(text.split()))[:count]:
        if out and len(out) + 1 + len(sentence) > most:
            break
        out = f"{out} {sentence}".strip()
    return _clip(out, most)


# ---------- Wikivoyage ----------

#: A guide's sections for each kind of place, as Wikivoyage names them.
SECTIONS = {"see": "See", "do": "Do", "eat": "Eat"}
#: Named places per kind.
MOST_LISTINGS = 5
#: A big city's district guides read at most.
MOST_DISTRICTS = 8
SUMMARY_CHARS = 300
_QUERY = {"action": "query", "format": "json", "formatversion": "2", "redirects": "1"}
_HEADING = re.compile(r"^==\s*([^=].*?)\s*==\s*$", re.M)
#: A listing template, such as {{see | name=… | content=… }} or {{listing | type=see | name=… }}.
_LISTING = re.compile(r"\{\{\s*(?:see|do|eat|drink|buy|listing)\s*\|", re.I)
_GEO = re.compile(r"\{\{\s*(?:geo|mapframe)\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)", re.I)
_DISAMBIGUATION = re.compile(r"\{\{\s*(?:disamb|disambig|dab)\s*[|}]", re.I)
#: "Bengaluru (Kannada: ಬೆಂಗಳೂರು Bengaḷūru), formerly …": the name in other languages, which the summary leaves out.
_OTHER_NAMES = re.compile(r"\s*\([^()]*:[^()]*\)")


def _plain(wikitext: str) -> str:
    """Wikitext as plain words: links as their text; templates, markup and comments gone."""
    s = re.sub(r"<!--.*?-->", "", wikitext, flags=re.S)
    for _ in range(3):  # templates inside templates, innermost first
        s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"\[\[(?:File|Image):[^\]]*\]\]", "", s, flags=re.I)
    s = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\s+([^\]]*)\]", r"\1", s)
    s = re.sub(r"\[https?://\S+\]", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s.replace("'''", "").replace("''", ""))
    return " ".join(s.split())


def _sections(wikitext: str) -> dict[str, str]:
    """A page by its top-level sections (each with its subsections); "" is the part before the first."""
    parts = _HEADING.split(wikitext)
    return {"": parts[0], **{h.strip(): body for h, body in zip(parts[1::2], parts[2::2], strict=True)}}


def _fields(body: str) -> dict[str, str]:
    """A template's named fields, split at the bars that aren't inside a link or another template."""
    parts, depth, start, i = [], 0, 0, 0
    while i < len(body):
        two = body[i : i + 2]
        if two in ("{{", "[["):
            depth, i = depth + 1, i + 2
            continue
        if two in ("}}", "]]"):
            depth, i = max(0, depth - 1), i + 2
            continue
        if body[i] == "|" and depth == 0:
            parts.append(body[start:i])
            start = i + 1
        i += 1
    parts.append(body[start:])
    fields = {}
    for part in parts:
        key, eq, value = part.partition("=")
        if eq:
            fields[key.strip().lower()] = value
    return fields


def _listings(wikitext: str) -> list[Listing]:
    """Each named listing in a section, in the guide's order."""
    out, at = [], 0
    while m := _LISTING.search(wikitext, at):
        depth, i = 1, m.end()
        while i < len(wikitext) and depth:
            two = wikitext[i : i + 2]
            depth += 1 if two == "{{" else -1 if two == "}}" else 0
            i += 2 if two in ("{{", "}}") else 1
        at = i
        fields = _fields(wikitext[m.end() : i - 2])
        name = _plain(fields.get("name", ""))
        if not name:
            continue
        out.append(
            Listing(
                name=_clip(name, 100),
                about=_sentences(_plain(fields.get("content", "")), 140, 1),
                hours=_clip(_plain(fields.get("hours", "")), 60),
                price=_clip(_plain(fields.get("price", "")), 60),
                notable=bool(re.fullmatch(r"\s*Q\d+\s*", fields.get("wikidata", ""))),
            )
        )
    return out


def _pick(pages: list[list[Listing]]) -> tuple[Listing, ...]:
    """A few named places: from each page in turn, those with a Wikidata entry (better known) first."""
    picked: list[Listing] = []
    seen: set[str] = set()
    for notable in (True, False):
        for row in zip_longest(*([x for x in page if x.notable == notable] for page in pages)):
            for x in row:
                if x is not None and x.name.lower() not in seen and len(picked) < MOST_LISTINGS:
                    seen.add(x.name.lower())
                    picked.append(x)
    return tuple(picked)


def _districts(title: str, districts: str) -> list[str]:
    """A big city's district guides, named in its Districts section ([[Bengaluru/South|South Bengaluru]])."""
    found = re.findall(r"\[\[\s*(" + re.escape(title) + r"/[^|\]#]+)", districts)
    return list(dict.fromkeys(t.strip() for t in found))[:MOST_DISTRICTS]


def _centre(wikitext: str) -> tuple[float | None, float | None]:
    m = _GEO.search(wikitext)
    if not m:
        return None, None
    lat, lng = float(m.group(1)), float(m.group(2))
    return (lat, lng) if -90 <= lat <= 90 and -180 <= lng <= 180 else (None, None)


def _guide_from(data: dict[str, Any]) -> CityGuide:
    return CityGuide(**{**data, **{kind: tuple(Listing(**x) for x in data[kind]) for kind in SECTIONS}})


async def city_guide(city: str, client: httpx.AsyncClient | None = None) -> CityGuide | None:
    """Wikivoyage's guide to a city: a short summary and up to 5 named places to see, things to do and places to
    eat. None when Wikivoyage has no guide by that name (or only a page listing places of that name), when it
    doesn't answer, or when WIKIVOYAGE_URL is empty."""
    url = get_settings().wikivoyage_url
    # A title can't hold these, and a bar would ask for two pages.
    name = " ".join(re.sub(r"[|#<>\[\]{}]", " ", city).split())[:80]
    if not url or not name:
        return None
    key = "guide:city:" + name.lower()
    cached = _cached(key)
    if cached is not None:
        data = json.loads(cached)
        return _guide_from(data) if data else None
    params = {**_QUERY, "titles": name, "prop": "extracts|revisions", "exintro": "1", "explaintext": "1", "rvprop": "content", "rvslots": "main"}
    res = await _call("Wikivoyage", "GET", url, WIKIVOYAGE_TIMEOUT, client, params=params)
    if res is None:
        return None
    try:
        page = res.json()["query"]["pages"][0]
        if page.get("missing") or page.get("invalid"):
            _keep(key, "null", NO_GUIDE_SECONDS)
            return None
        title, wikitext, extract = page["title"], page["revisions"][0]["slots"]["main"]["content"], page.get("extract") or ""
    except (ValueError, LookupError, TypeError) as exc:
        log.warning("Wikivoyage sent something unexpected (%s)", type(exc).__name__)
        return None
    if _DISAMBIGUATION.search(wikitext):
        _keep(key, "null", NO_GUIDE_SECONDS)
        return None
    sections = _sections(wikitext)
    pages = {kind: [_listings(sections.get(heading, ""))] for kind, heading in SECTIONS.items()}
    complete = True
    districts = _districts(title, sections.get("Districts", ""))
    if districts and any(len(found[0]) < MOST_LISTINGS for found in pages.values()):
        more = await _district_pages(url, districts, client)
        complete = more is not None
        for text in more or []:
            parts = _sections(text)
            for kind, heading in SECTIONS.items():
                pages[kind].append(_listings(parts.get(heading, "")))
    lat, lng = _centre(wikitext)
    summary = _sentences(_OTHER_NAMES.sub("", extract, count=1) or _plain(sections[""]), SUMMARY_CHARS, 3)
    guide = CityGuide(title=title, summary=summary, see=_pick(pages["see"]), do=_pick(pages["do"]), eat=_pick(pages["eat"]), lat=lat, lng=lng)
    # A guide missing its districts (they didn't come) isn't kept: the next look tries again.
    if complete:
        _keep(key, json.dumps(asdict(guide)), GUIDE_SECONDS)
    return guide


async def _district_pages(url: str, titles: list[str], client: httpx.AsyncClient | None) -> list[str] | None:
    """The district guides' wikitext, in the city guide's order, in one request; None when they don't come."""
    params = {**_QUERY, "titles": "|".join(titles), "prop": "revisions", "rvprop": "content", "rvslots": "main"}
    res = await _call("Wikivoyage", "GET", url, WIKIVOYAGE_TIMEOUT, client, params=params)
    if res is None:
        return None
    try:
        found = [p for p in res.json()["query"]["pages"] if not p.get("missing")]
        order = {t: i for i, t in enumerate(titles)}
        return [p["revisions"][0]["slots"]["main"]["content"] for p in sorted(found, key=lambda p: order.get(p["title"], len(order)))]
    except (ValueError, LookupError, TypeError) as exc:
        log.warning("Wikivoyage sent something unexpected (%s)", type(exc).__name__)
        return None


# ---------- OpenStreetMap, through Overpass ----------

#: What each kind of place is in OpenStreetMap's tags.
KINDS: dict[str, tuple[str, ...]] = {
    "see": ('["tourism"~"^(attraction|museum|viewpoint|gallery)$"]', '["historic"~"^(monument|fort|palace|memorial)$"]'),
    "do": ('["tourism"~"^(zoo|theme_park)$"]', '["leisure"~"^(park|garden)$"]'),
    "eat": ('["amenity"~"^(restaurant|cafe)$"]',),
}
#: How far to look: a meal close by, a sight or a park a short ride away (metres).
RADIUS_M = {"see": 5000, "do": 5000, "eat": 1500}
#: Overpass is asked about the point rounded to 0.01° (about a kilometre), so it looks this much further.
CELL_SLACK_M = 800
#: Places asked of Overpass, and given back nearest first.
FETCH = 100
MOST_PLACES = 20
_WHAT = {
    "monument": "monument", "fort": "fort", "palace": "palace", "memorial": "memorial", "attraction": "sight", "museum": "museum",
    "viewpoint": "viewpoint", "gallery": "gallery", "zoo": "zoo", "theme_park": "theme park", "park": "park", "garden": "garden",
    "restaurant": "restaurant", "cafe": "cafe",
}  # fmt: skip


def overpass_query(lat: float, lng: float, kind: str) -> str:
    """Named places of a kind around a point (a way or an area by its centre), in Overpass QL."""
    around = f"(around:{RADIUS_M[kind] + CELL_SLACK_M},{lat:.2f},{lng:.2f})"
    wanted = "".join(f'nwr{around}{tags}["name"];' for tags in KINDS[kind])
    return f"[out:json][timeout:8];({wanted});out center {FETCH};"


def _what(tags: dict[str, str]) -> str:
    what = next((_WHAT[tags[k]] for k in ("historic", "tourism", "leisure", "amenity") if tags.get(k) in _WHAT), "place")
    cuisine = tags.get("cuisine", "").split(";")[0].replace("_", " ").strip()
    return f"{what}, {cuisine}" if cuisine and what in ("restaurant", "cafe") else what


def _elements(res: httpx.Response) -> list[dict[str, Any]] | None:
    """Overpass's named places, as kept in the cache; None when its answer is an error."""
    try:
        body = res.json()
        if "error" in str(body.get("remark", "")).lower():
            log.warning("Overpass couldn't finish the search")
            return None
        out = []
        for el in body["elements"]:
            tags = el.get("tags") or {}
            name = (tags.get("name:en") or tags.get("name") or "").strip()
            point = el if "lat" in el else el.get("center") or {}
            if name and "lat" in point and "lon" in point:
                notable = bool(tags.get("wikidata") or tags.get("wikipedia"))
                out.append({"name": _clip(name, 100), "what": _what(tags), "lat": float(point["lat"]), "lng": float(point["lon"]), "notable": notable})
        return out
    except (ValueError, LookupError, TypeError, AttributeError) as exc:
        log.warning("Overpass sent something unexpected (%s)", type(exc).__name__)
        return None


async def places_near(lat: float, lng: float, kind: str, client: httpx.AsyncClient | None = None) -> list[Sight]:
    """Named places of a kind ("see", "do" or "eat") near a point, nearest first: at most 20, within 5 km (1.5 km
    to eat). Empty when there are none, when Overpass is busy or doesn't answer, or when OVERPASS_URL is empty."""
    url = get_settings().overpass_url
    if kind not in KINDS or not url:
        return []
    cell = (round(lat, 2), round(lng, 2))
    key = f"guide:near:{kind}:{cell[0]:.2f},{cell[1]:.2f}"
    cached = _cached(key)
    if cached is not None:
        found = json.loads(cached)
    else:
        res = await _call("Overpass", "POST", url, OVERPASS_TIMEOUT, client, data={"data": overpass_query(*cell, kind)})
        found = _elements(res) if res is not None else None
        if found is None:
            return []
        _keep(key, json.dumps(found), PLACES_SECONDS)
    nearest: dict[str, Sight] = {}
    for x in found:
        sight = Sight(**x, metres=round(metres((lng, lat), (x["lng"], x["lat"]))))
        same = nearest.get(sight.name.lower())
        if sight.metres <= RADIUS_M[kind] and (same is None or sight.metres < same.metres):
            nearest[sight.name.lower()] = sight
    return sorted(nearest.values(), key=lambda s: s.metres)[:MOST_PLACES]


# ---------- the web, through Gemini with Google Search ----------

LOOK_UP_PROMPT = """\
You look things up on the web for Rico, a travel companion in India, using Google Search. Answer the traveller's \
question in at most three short sentences of plain English, from what the pages say: names, opening hours, entry \
fees, how to get there. No markdown, no lists, no emoji. If the pages don't say, say you couldn't find it.
"""
MOST_SOURCES = 3


def _search_models() -> list[str]:
    """Rico's model, then the AI helper's, less any resting: one the agent rests (its quota is used up), or one
    whose Google Search quota is."""
    s = get_settings()
    out = []
    for model in dict.fromkeys((s.roo_agent_model, s.gemini_model)):
        try:
            if get_redis().exists(_COOLDOWN_KEY + model, SEARCH_REST_KEY + model):
                continue
        except redis.RedisError:
            pass
        out.append(model)
    return out


def _grounded(res: httpx.Response) -> WebAnswer | None:
    """The answer's words and up to 3 pages it was grounded in; None when there are no words."""
    try:
        candidate = res.json()["candidates"][0]
        text = "".join(p.get("text", "") for p in candidate["content"]["parts"] if not p.get("thought")).strip()
        sources: list[Source] = []
        for chunk in (candidate.get("groundingMetadata") or {}).get("groundingChunks") or []:
            web = chunk.get("web") or {}
            url, title = web.get("uri"), web.get("title") or web.get("domain")
            if url and title and all(x.url != url for x in sources) and len(sources) < MOST_SOURCES:
                sources.append(Source(_clip(title, 100), url))
    except (ValueError, LookupError, TypeError, AttributeError) as exc:
        log.warning("Gemini sent something unexpected for a look-up (%s)", type(exc).__name__)
        return None
    return WebAnswer(_clip(text, 600), tuple(sources)) if text else None


async def web_answer(question: str, client: httpx.AsyncClient | None = None) -> WebAnswer | None:
    """A short answer from the web, with up to 3 of the pages it read: Gemini, grounded in Google Search. Uses
    ROO_AGENT_MODEL, else GEMINI_MODEL while the first rests. None without the AI helper and a key, or when no
    model can answer now."""
    s = get_settings()
    asked = " ".join(question.split())[:300]
    if not (s.ai_helper_enabled and s.gemini_api_key and asked):
        return None
    key = "guide:web:" + hashlib.sha256(asked.lower().encode()).hexdigest()[:32]
    cached = _cached(key)
    if cached is not None:
        data = json.loads(cached)
        return WebAnswer(data["text"], tuple(Source(**x) for x in data["sources"]))
    body = {
        "systemInstruction": {"parts": [{"text": LOOK_UP_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": asked}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {"temperature": 0.2, "thinkingConfig": {"thinkingLevel": "low"}},
    }
    # The key goes in a header, not the URL, so it never lands in access or error logs.
    headers = {"x-goog-api-key": s.gemini_api_key, "User-Agent": USER_AGENT}
    for model in _search_models():
        url = GEMINI_URL.format(model=model)
        try:
            if client is None:
                async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT) as own:
                    res = await own.post(url, json=body, headers=headers)
            else:
                res = await client.post(url, json=body, headers=headers, timeout=SEARCH_TIMEOUT)
        except httpx.HTTPError as exc:
            log.warning("A web look-up with %s failed (%s)", model, type(exc).__name__)
            return None
        if res.status_code == 429:
            # Its quota (or Google Search's) is used up: leave it alone as long as Gemini says, and try the other.
            _keep(SEARCH_REST_KEY + model, "1", _wait_seconds(res))
            log.warning("%s has used up its quota for web look-ups; resting it", model)
            continue
        if res.status_code != 200:
            log.warning("A web look-up with %s answered %s", model, res.status_code)
            return None
        answer = _grounded(res)
        if answer is not None:
            _keep(key, json.dumps(asdict(answer)), WEB_SECONDS)
        return answer
    return None
