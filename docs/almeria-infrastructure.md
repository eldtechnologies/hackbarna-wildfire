# Eastern Almería infrastructure

The demo now includes the eastern Almería rectangle [-2.45, 36.8, -1.55, 37.65] (west, south, east, north). This adds 10 hospital features, 153 school features, 601 settlement nodes and 315 clipped power-line segments. These are mapped OSM objects, not guaranteed unique institutions; separate buildings in one school may carry the same name.

Source: [Geofabrik Andalucía](https://download.geofabrik.de/europe/spain/andalucia.html), OpenStreetMap snapshot 2026-09-18T20:21:10Z, ODbL 1.0, © OpenStreetMap contributors. The source SHA-256 and counts are in `data/infrastructure/almeria-source.json`. This snapshot postdates the July replay and is a current contextual inventory, not verified historical exposure. Completeness is not guaranteed. The report displays the snapshot limitation.

The importer preserves the Catalonia assets. Coverage remains two separate rectangles; the region between them is not claimed as covered. Hospitals/schools use OSM amenity tags and area representative points, settlements use place nodes, and power-line geometry is clipped without joining disjoint pieces. Voltage is retained only where OSM supplies it.

Reproduce with Python 3.12+, osmium 4.3.1 and Shapely 2.x:

```sh
python scripts/import-almeria-infrastructure.py --pbf /path/to/andalucia.osm.pbf
```

The app serves the bundled files offline. It does not call Overpass at runtime. This adds map/proximity context and makes no change to the road graph, road accessibility or routing decisions. Proximity matches are not evacuation instructions.
