"""Where each city on Reroute's list of Indian cities is, from OpenStreetMap: its centre and its area.

Run it with the backend's Python, once, and again after adding cities to backend/app/india.py (it asks only
about cities the file doesn't have yet):

    backend/.venv/bin/python infra/cities/from_osm.py examples/india-cities.json

It asks Nominatim for each city by its name and state, one request a second as Nominatim's usage policy
asks, and keeps the settlement in that state that OpenStreetMap ranks first (by an older name if the current
one finds nothing). The area is the one Reroute gives any town it looks up itself (backend/app/cities.py):
OpenStreetMap's outline with a margin, at least about 22 km either side of the centre. A city placed by hand
(its `note` says why) stays as it is. The data is © OpenStreetMap contributors, available under the Open
Database License (ODbL); the file it writes says so.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.cities import area  # noqa: E402
from app.india import CITIES  # noqa: E402

NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "Reroute/1.0 (travel planner)"
#: What counts as a city, as in backend/app/adapters/places.py. A city OpenStreetMap files as something
#: else (a suburb of a bigger one, say) is taken by its name as a last resort.
SETTLEMENTS = ("city", "town", "municipality", "village")
NOTE = (
    "Where each city on Reroute's list (backend/app/india.py) is: its centre (lat, lng) and its area (west, south, east, north), "
    "OpenStreetMap's outline of the city with a margin, at least about 22 km either side of the centre. Place search and trips "
    "stay inside the area. Map data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright)."
)
_last = 0.0


def search(q: str, settlement: bool) -> list[dict]:
    global _last
    params = {"q": q, "format": "jsonv2", "addressdetails": 1, "limit": 10, "countrycodes": "in"}
    if settlement:
        params["featureType"] = "settlement"
    # At most one request a second.
    time.sleep(max(0.0, _last + 1.1 - time.monotonic()))
    req = urllib.request.Request(f"{NOMINATIM}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    finally:
        _last = time.monotonic()


def find(name: str, state: str, other: tuple[str, ...]) -> dict | None:
    """The city in its state: a settlement by its name, then by an older one; then anything by that name."""
    for settlement in (True, False):
        for n in (name, *other):
            for item in search(f"{n}, {state}", settlement):
                in_state = item.get("address", {}).get("state") == state
                if in_state and (not settlement or item.get("addresstype") in SETTLEMENTS):
                    return item
    return None


def row(name: str, state: str, item: dict) -> dict:
    lat, lng = float(item["lat"]), float(item["lon"])
    south, north, west, east = (float(x) for x in item["boundingbox"])
    w, s, e, n = area(lng, lat, (west, south, east, north))
    osm = f"{item.get('osm_type', 'x')[:1]}{item.get('osm_id')}"
    return {"name": name, "state": state, "lat": round(lat, 5), "lng": round(lng, 5), "west": w, "south": s, "east": e, "north": n, "osmId": osm}


def write(out: Path, cities: list[dict]) -> None:
    """One city a line, so a change to the list is a readable diff."""
    head = {"note": NOTE, "source": "OpenStreetMap via Nominatim (infra/cities/from_osm.py)", "licence": "ODbL-1.0"}
    lines = [f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}," for k, v in head.items()]
    body = ",\n".join(f"    {json.dumps(c, ensure_ascii=False)}" for c in cities)
    out.write_text("{\n" + "\n".join(lines) + '\n  "cities": [\n' + body + "\n  ]\n}\n", encoding="utf-8", newline="\n")


def main(out: Path) -> None:
    # OpenStreetMap's names aren't all in a Windows console's code page.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    kept = {(c["name"], c["state"]): c for c in json.loads(out.read_text(encoding="utf-8"))["cities"]} if out.exists() else {}
    cities, missing = [], []
    try:
        for name, state, other in CITIES:
            if (name, state) in kept:
                cities.append(kept[(name, state)])
                continue
            item = find(name, state, other)
            if item is None:
                missing.append(f"{name}, {state}")
                continue
            cities.append(row(name, state, item))
            print(f"{name}, {state}: {item.get('addresstype')} {item.get('display_name', '')[:60]}")
    finally:
        # Whatever was found is kept, so a run cut short (no connection, Nominatim busy) carries on from there.
        write(out, cities)
        print(f"{len(cities)} cities written to {out}")
    if missing:
        sys.exit("Not found, looked up when first picked instead: " + "; ".join(missing))


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "examples/india-cities.json"))
