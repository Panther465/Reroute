#!/bin/sh
# Prepares OpenStreetMap data for OSRM (car and foot), once. Later starts reuse the volume.
# The osrm-download service fetches /data/region.osm.pbf first (this image has no wget or curl).
# Each profile writes a .ready file only when every step has finished, so a prepare that was
# interrupted halfway is done again from the start rather than served half-built.
set -eu

if [ -f /data/car/.ready ] && [ -f /data/foot/.ready ]; then
  echo "OSRM data already prepared."
  exit 0
fi

if [ ! -f /data/region.osm.pbf ]; then
  echo "No map at /data/region.osm.pbf: the osrm-download service should have fetched it." >&2
  exit 1
fi

for profile in car foot; do
  if [ -f "/data/${profile}/.ready" ]; then
    echo "OSRM ${profile} data already prepared."
    continue
  fi
  rm -rf "/data/${profile}"
  mkdir -p "/data/${profile}"
  cp /data/region.osm.pbf "/data/${profile}/region.osm.pbf"
  osrm-extract -p "/opt/${profile}.lua" "/data/${profile}/region.osm.pbf"
  osrm-partition "/data/${profile}/region.osrm"
  osrm-customize "/data/${profile}/region.osrm"
  rm -f "/data/${profile}/region.osm.pbf"
  touch "/data/${profile}/.ready"
done
echo "OSRM data ready."
