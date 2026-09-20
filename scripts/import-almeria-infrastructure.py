"""Add an offline OSM extract around Los Gallardos to the bundled infrastructure.

Requires osmium and shapely. Uses complete OSM areas for school/hospital points,
place nodes for settlements, and clipped line geometry for power infrastructure.
Existing Catalonia features are retained. Reimport replaces this region's features.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import osmium
from shapely.geometry import LineString, Point, shape, box

BBOX = [-2.45, 36.8, -1.55, 37.65]
REGION = 'eastern-almeria'
FILES = {'hospital': 'hospitals.geojson', 'school': 'schools.geojson',
         'town': 'towns.geojson', 'power-line': 'power-lines.geojson'}


class Infrastructure(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features = {kind: [] for kind in FILES}
        self.bounds = box(*BBOX)
        self.factory = osmium.geom.GeoJSONFactory()
        self.rejected = []

    def point(self, kind, osm_type, osm_id, tags, point):
        if not self.bounds.covers(point):
            return
        identity = f'osm-{REGION}-{osm_type}-{osm_id}'
        name = tags.get('name') or f'{kind.title()} (OSM {osm_type} {osm_id})'
        self.features[kind].append(dict(type='Feature', id=identity,
            properties=dict(id=identity, name=name, category=kind, region=REGION,
                            municipality=tags.get('addr:city'), osm_type=osm_type,
                            osm_id=osm_id, source='OpenStreetMap contributors'),
            geometry=dict(type='Point', coordinates=[point.x, point.y])))

    def node(self, node):
        tags = dict(node.tags)
        kind = tags.get('amenity')
        if kind not in ('hospital', 'school'):
            kind = 'town' if tags.get('place') in ('city','town','village','hamlet') else None
        if kind and node.location.valid():
            self.point(kind, 'node', node.id, tags, Point(node.location.lon, node.location.lat))

    def area(self, area):
        tags = dict(area.tags)
        kind = tags.get('amenity')
        if kind not in ('hospital', 'school'):
            return
        geom = shape(json.loads(self.factory.create_multipolygon(area)))
        if geom.is_empty or not geom.is_valid:
            self.rejected.append(f'area/{area.orig_id()}')
            return
        self.point(kind, 'way' if area.from_way() else 'relation', area.orig_id(), tags, geom.representative_point())

    def way(self, way):
        tags = dict(way.tags)
        if tags.get('power') not in ('line', 'minor_line'):
            return
        if len(way.nodes) < 2 or not all(n.location.valid() for n in way.nodes):
            self.rejected.append(f'way/{way.id}')
            return
        line = LineString([(n.lon, n.lat) for n in way.nodes]).intersection(self.bounds)
        pieces = [line] if line.geom_type == 'LineString' else list(getattr(line, 'geoms', []))
        voltage = [float(v) / 1000 for v in tags.get('voltage', '').split(';') if v.strip().isdigit()]
        for i, part in enumerate(pieces):
            if part.is_empty or part.geom_type != 'LineString' or len(part.coords) < 2:
                continue
            identity = f'osm-{REGION}-way-{way.id}-part-{i}'
            self.features['power-line'].append(dict(type='Feature', id=identity,
                properties=dict(id=identity, name=tags.get('name') or f'Power line (OSM way {way.id})',
                                category='power-line', region=REGION, voltageKv=max(voltage) if voltage else None,
                                operator=tags.get('operator'), osm_type='way', osm_id=way.id,
                                source='OpenStreetMap contributors'),
                geometry=dict(type='LineString', coordinates=list(part.coords))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pbf', type=Path, required=True)
    ap.add_argument('--out', type=Path, default=Path('data/infrastructure'))
    a = ap.parse_args()
    reader = osmium.io.Reader(str(a.pbf))
    header = reader.header()
    timestamp = header.get('osmosis_replication_timestamp')
    reader.close()
    if not timestamp:
        raise ValueError('OSM snapshot needs a source timestamp')
    handler = Infrastructure()
    handler.apply_file(str(a.pbf), locations=True, idx='flex_mem')
    if not all(handler.features.values()):
        raise ValueError('Refusing incomplete region import: a required category is empty')
    if handler.rejected:
        raise ValueError(f'Invalid source geometries: {handler.rejected[:10]}')
    with a.pbf.open('rb') as source_file:
        source_hash = hashlib.file_digest(source_file, 'sha256').hexdigest()
    metadata = dict(region=REGION, bbox=BBOX, snapshot_at=timestamp,
                    source='https://download.geofabrik.de/europe/spain/andalucia.html',
                    license='ODbL 1.0, © OpenStreetMap contributors',
                    source_sha256=source_hash,
                    scope='OSM mapped assets; completeness not guaranteed. Snapshot postdates the July replay.',
                    counts={k: len(v) for k, v in handler.features.items()})
    a.out.mkdir(parents=True, exist_ok=True)
    prepared = []
    for kind, filename in FILES.items():
        target = a.out/filename
        collection = json.loads(target.read_text()) if target.exists() else dict(type='FeatureCollection', properties={}, features=[])
        collection['features'] = [f for f in collection['features'] if f.get('properties', {}).get('region') != REGION]
        collection['features'].extend(sorted(handler.features[kind], key=lambda f: f['id']))
        collection.setdefault('properties', {})['almeria_source'] = metadata
        tmp = target.with_suffix('.geojson.tmp')
        tmp.write_text(json.dumps(collection, ensure_ascii=False, separators=(',', ':'))+'\n')
        prepared.append((tmp, target))
    for tmp, target in prepared:
        tmp.replace(target)
    (a.out/'almeria-source.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(metadata, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
