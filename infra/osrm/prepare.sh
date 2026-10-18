#!/bin/sh
# Prepares OpenStreetMap data for OSRM (car and foot), once. Later starts reuse the volume.
set -eu

if [ -f /data/car/region.osrm.mldgr ] && [ -f /data/foot/region.osrm.mldgr ]; then
  echo "OSRM data already prepared."
  exit 0
fi

mkdir -p /data/car /data/foot
if [ ! -f /data/region.osm.pbf ]; then
  echo "Downloading ${OSM_EXTRACT_URL}"
  wget -q -O /data/region.osm.pbf "${OSM_EXTRACT_URL}"
fi

for profile in car foot; do
  cp /data/region.osm.pbf "/data/${profile}/region.osm.pbf"
  osrm-extract -p "/opt/${profile}.lua" "/data/${profile}/region.osm.pbf"
  osrm-partition "/data/${profile}/region.osrm"
  osrm-customize "/data/${profile}/region.osrm"
  rm -f "/data/${profile}/region.osm.pbf"
done
echo "OSRM data ready."
