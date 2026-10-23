"""Bengaluru's metro lines from OpenStreetMap, for drawing metro rides on the map: each line's stations in order.

Run once, and again when a line opens:

    python infra/metro/from_osm.py examples/bengaluru/metro.json

It asks the Overpass API for Namma Metro's route relations and keeps, for each line, the direction with the
most stations. The data is © OpenStreetMap contributors, available under the Open Database License (ODbL);
the file it writes says so. Timetables (`stations` and `rides`, for planning) are a separate matter: this
script leaves any that the file already has untouched.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

#: The main Overpass instance first, then a mirror (some networks can't reach the main one).
OVERPASS = ("https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter")
USER_AGENT = "Reroute student project (https://github.com/Panther465/Reroute)"
#: Bengaluru and its suburbs: south, west, north, east.
#: Overpass finds the routes (tags only: a mirror times out on member lists); the OpenStreetMap API gives
#: each route's members and its stops, in a handful of light requests.
ROUTES = '[out:json][timeout:120];relation["route"="subway"](12.70,77.30,13.30,77.90);out tags;'
OSM_API = "https://api.openstreetmap.org/api/0.6"
COLOURS = {"purple": "#8e2a8f", "green": "#13a84a", "yellow": "#e3b505", "pink": "#e75480", "blue": "#2c6fbf"}


def overpass(query: str) -> list[dict]:
    data = urllib.parse.urlencode({"data": query}).encode()
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=180) as res:
                return json.load(res)["elements"]
        except OSError as exc:
            print(f"{url}: {exc}", file=sys.stderr)
    sys.exit("No Overpass instance answered.")


def osm_api(path: str) -> list[dict]:
    req = urllib.request.Request(f"{OSM_API}/{path}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)["elements"]


def fetch() -> dict:
    """The route relations with their members, then only their stop nodes."""
    routes = [r for found in overpass(ROUTES) for r in osm_api(f"relation/{found['id']}.json")]
    ids = sorted({m["ref"] for r in routes for m in r.get("members", []) if m["type"] == "node" and m.get("role", "").startswith("stop")})
    nodes = [n for i in range(0, len(ids), 100) for n in osm_api(f"nodes.json?nodes={','.join(map(str, ids[i : i + 100]))}")]
    return {"elements": routes + nodes}


def lines(osm: dict) -> list[dict]:
    nodes = {e["id"]: e for e in osm["elements"] if e["type"] == "node"}
    best: dict[str, dict] = {}
    for rel in (e for e in osm["elements"] if e["type"] == "relation"):
        tags = rel.get("tags", {})
        name = tags.get("name", "")
        colour = next((c for c in COLOURS if re.search(rf"\b{c}\b", f"{name} {tags.get('colour', '')} {tags.get('ref', '')}", re.I)), None)
        if colour is None:
            continue
        stations = []
        for m in rel.get("members", []):
            node = nodes.get(m["ref"]) if m["type"] == "node" else None
            if node is None or not m.get("role", "").startswith("stop"):
                continue
            label = node.get("tags", {}).get("name:en") or node.get("tags", {}).get("name")
            if not label or (stations and stations[-1]["name"] == label):
                continue
            stations.append({"stationId": f"osm-n{node['id']}", "name": label, "lng": round(node["lon"], 6), "lat": round(node["lat"], 6)})
        line_id = f"{colour}-line"
        if len(stations) >= 2 and len(stations) > len(best.get(line_id, {}).get("stations", [])):
            best[line_id] = {"lineId": line_id, "name": f"{colour.capitalize()} Line", "colour": COLOURS[colour], "stations": stations}
    return [best[k] for k in sorted(best)]


def main(out: Path) -> None:
    found = lines(fetch())
    if not found:
        sys.exit("Overpass returned no metro lines; nothing written.")
    kept = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    kept.update(
        {
            "note": "Namma Metro lines and their stations in order, for drawing metro rides. Map data © OpenStreetMap contributors, ODbL (https://www.openstreetmap.org/copyright).",
            "source": "OpenStreetMap via Overpass (infra/metro/from_osm.py)",
            "lines": found,
        }
    )
    out.write_text(json.dumps(kept, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(", ".join(f"{x['name']}: {len(x['stations'])} stations" for x in found))


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "examples/bengaluru/metro.json"))
