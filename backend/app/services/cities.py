"""Finding a city from what a traveller types: a name ("Rajpura"), a misspelling ("bengluru"), the start
of a name ("raj"), or a sentence that mentions one ("I'm new to bengluru and staying at…").

The built-in list of Indian cities comes first (app/india.py): it forgives spelling and knows other
names (Bombay, Gurgaon). Then OpenStreetMap, for any other town. A city is kept in the cities table the
first time it's needed, with its area: OpenStreetMap's outline plus a margin, so a campus or an
industrial area just outside town still counts.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.adapters.places import FoundCity, NominatimSearch
from app.cities import CITIES, City
from app.db import session_scope
from app.india import CITIES as INDIA
from app.models import CityRow
from app.redis_client import get_redis

log = logging.getLogger("reroute.cities")

#: Words that come before a city in a sentence: "new to Pune", "visiting Delhi", "in Rajpura".
CUES = frozenset({"to", "in", "at", "visiting", "visit", "from", "reach", "reaching", "city", "into", "near", "around"})
#: Words after a cue that aren't a city: "in the hotel", "to my college".
NOT_A_CITY = frozenset(
    {"the", "a", "an", "my", "our", "your", "this", "that", "there", "here", "it", "be", "go", "get", "do", "see", "meet", "work", "office"}
    | {"college", "university", "hotel", "home", "time", "morning", "evening", "night", "today", "tomorrow", "and", "i", "me", "we", "will"}
)
#: An area is at least this many degrees either side of the centre (about 22 km), and at most 0.6.
MIN_HALF, MAX_HALF, MARGIN = 0.2, 0.6, 0.08


@dataclass(frozen=True)
class CityChoice:
    """A city to offer. One from the built-in list may not be looked up yet: that happens when it's picked."""

    slug: str
    name: str
    state: str | None
    sample: bool = False


def plain(text: str) -> str:
    """Lower case, no accents: letters, digits and single spaces."""
    t = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def slugify(text: str) -> str:
    s = plain(text).replace(" ", "-")
    return (s if s[:1].isalpha() else f"c-{s}")[:40].rstrip("-")


_ALIASES = [(plain(n), i) for i, (name, _, other) in enumerate(INDIA) for n in (name, *other)]
_BY_SLUG = {slugify(name): i for i, (name, _, _) in enumerate(INDIA)}


def _distance(a: str, b: str, limit: int) -> int:
    """Edits between two words (a swap of neighbours counts once); anything over the limit is limit + 1."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2: list[int] = []
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            row[j] = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                row[j] = min(row[j], prev2[j - 2] + 1)
        if min(row) > limit:
            return limit + 1
        prev2, prev = prev, row
    return prev[-1]


def _allowed(n: int) -> int:
    """Spelling slips forgiven for a name of n letters: none up to 4, one up to 7, then two."""
    return 0 if n <= 4 else 1 if n <= 7 else 2


def mentioned(text: str) -> list[int]:
    """Cities on the built-in list that the text names, best match first (indexes into app.india)."""
    words = plain(text).split()[:80]
    sentence = len(words) > 3
    best: dict[int, tuple[float, str]] = {}
    for i in range(len(words)):
        cue = i > 0 and words[i - 1] in CUES
        for n in (3, 2, 1):
            if i + n > len(words):
                continue
            chunk = " ".join(words[i : i + n])
            for alias, idx in _ALIASES:
                if alias[0] != chunk[0]:
                    continue
                if alias == chunk:
                    score = 0.0
                elif not sentence and len(chunk) >= 3 and alias.startswith(chunk):
                    score = 0.5  # typing a name: "raj" offers Rajpura and Rajkot
                else:
                    # In a sentence a short name must be exact unless a cue comes before it: "sales" isn't Salem.
                    limit = 0 if sentence and not cue and len(alias) <= 6 else _allowed(len(alias))
                    if limit == 0:
                        continue
                    d = _distance(alias, chunk, limit)
                    if d > limit:
                        continue
                    score = float(d)
                if idx not in best or score < best[idx][0]:
                    best[idx] = (score, INDIA[idx][0])
    return [idx for idx, _ in sorted(best.items(), key=lambda kv: kv[1])]


def _after_cues(words: list[str]) -> list[str]:
    """In a sentence, the words after "to", "in", "visiting"…, as names to look up: "new to rajpura"."""
    out = []
    for i, w in enumerate(words[:-1]):
        nxt = words[i + 1]
        if w in CUES and nxt not in NOT_A_CITY and nxt not in CUES and len(nxt) >= 3 and not nxt.isdigit():
            out.append(nxt)
    return out


def _choice(row: CityRow) -> CityChoice:
    return CityChoice(slug=row.slug, name=row.name, state=row.state)


def _from_list(db: Session, idx: int) -> CityChoice:
    name, state, _ = INDIA[idx]
    slug = slugify(name)
    if slug in CITIES:
        c = CITIES[slug]
        return CityChoice(slug=c.slug, name=c.name, state=c.state, sample=c.sample)
    row = db.get(CityRow, slug)
    return _choice(row) if row else CityChoice(slug=slug, name=name, state=state)


def _area(found: FoundCity) -> tuple[float, float, float, float]:
    """OpenStreetMap's outline of the city with a margin, centred on the city, at least about 22 km either way."""
    west, south, east, north = found.bbox
    half_lat = min(max((north - south) / 2 + MARGIN, MIN_HALF), MAX_HALF)
    half_lng = min(max((east - west) / 2 + MARGIN, MIN_HALF), MAX_HALF)
    return (round(found.lng - half_lng, 5), round(found.lat - half_lat, 5), round(found.lng + half_lng, 5), round(found.lat + half_lat, 5))


def _keep(db: Session, slug: str, found: FoundCity, name: str | None = None, state: str | None = None) -> CityRow:
    west, south, east, north = _area(found)
    values = {"slug": slug, "name": (name or found.name)[:80], "state": state or found.state or None, "osm_id": found.osm_id}
    values |= {"west": west, "south": south, "east": east, "north": north}
    # Two people may pick the same new city at once: the first one in keeps it.
    db.execute(insert(CityRow).values(**values).on_conflict_do_nothing(index_elements=["slug"]))
    return db.get(CityRow, slug)  # type: ignore[return-value]


def _slug_for(db: Session, found: FoundCity) -> str:
    """The town's own name, unless another city already has it: then its state too ("bilaspur-himachal-pradesh")."""
    slug = slugify(found.name)
    row = db.get(CityRow, slug)
    listed = _BY_SLUG.get(slug)
    taken = slug in CITIES or (row is not None and row.state != found.state) or (listed is not None and INDIA[listed][1] != found.state)
    return slugify(f"{found.name} {found.state or ''}") if taken else slug


def find_cities(db: Session, text: str, limit: int = 5) -> list[CityChoice]:
    """Cities that match what was typed, best first. A sentence gives at most its one best city."""
    words = plain(text[:300]).split()
    if not words or len("".join(words)) < 2:
        return []
    sentence = len(words) > 3
    listed = mentioned(" ".join(words))
    if listed:
        return [_from_list(db, i) for i in listed[: 1 if sentence else limit]]
    # Not on the list: OpenStreetMap, for the name itself or for the words after "to", "in"… in a sentence.
    out: list[CityChoice] = []
    for q in _after_cues(words)[:2] if sentence else [" ".join(words)]:
        for found in NominatimSearch(get_redis()).settlements(q):
            slug = _slug_for(db, found)
            row = db.get(CityRow, slug) or _keep(db, slug, found)
            if all(c.slug != row.slug for c in out):
                out.append(_choice(row))
        if out:
            break
    db.commit()
    return out[: 1 if sentence else limit]


def _city(row: CityRow) -> City:
    return City(slug=row.slug, name=row.name, utc_offset=row.utc_offset, bbox=(row.west, row.south, row.east, row.north), state=row.state)


def kept_or_looked_up(slug: str) -> City | None:
    """A city from the cities table; or, for a city on the built-in list, looked up now and kept."""
    try:
        with session_scope() as db:
            row = db.get(CityRow, slug)
            if row is None and slug in _BY_SLUG:
                name, state, _ = INDIA[_BY_SLUG[slug]]
                found = NominatimSearch(get_redis()).settlements(f"{name}, {state}")
                match = next((f for f in found if f.state == state), found[0] if found else None)
                if match is None:
                    return None
                row = _keep(db, slug, match, name=name, state=state)
            return _city(row) if row else None
    except SQLAlchemyError as exc:
        log.warning("Couldn't read the city %s: %s", slug, exc)
        return None


def a_kept_city_covers(lng: float, lat: float) -> bool:
    try:
        with session_scope() as db:
            inside = select(CityRow.slug).where(CityRow.west <= lng, CityRow.east >= lng, CityRow.south <= lat, CityRow.north >= lat).limit(1)
            return db.scalar(inside) is not None
    except SQLAlchemyError:
        return False
