// Bundles real infrastructure GeoJSON from open data into
// data/infrastructure/*.geojson. Run once (and whenever data should be
// refreshed); the output is committed so the app never needs network access
// at runtime.
//
// Sources:
//  - Hospitals + schools: "Equipaments de Catalunya" (Generalitat de
//    Catalunya), analisi.transparenciacatalunya.cat dataset 8gmd-gz7i.
//  - Towns: "Caps de municipi de Catalunya georeferenciats", dataset wpyq-we8x.
//  - Power lines: OpenStreetMap high-voltage lines via the Overpass API
//    (the Generalitat catalog publishes no line geometry; OSM's power=line
//    coverage of the REE/REE-operated transmission network is the open
//    alternative).
//
// Usage: node scripts/fetch-infrastructure.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve(process.cwd(), 'data/infrastructure');

const GENCAT_EQUIPAMENTS = 'https://analisi.transparenciacatalunya.cat/resource/8gmd-gz7i.json';
const GENCAT_CAPS_MUNICIPI = 'https://analisi.transparenciacatalunya.cat/resource/wpyq-we8x.json';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const CAT = { latMin: 40.5, lonMin: 0.2, latMax: 42.9, lonMax: 3.5 };

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Socrata paginates at 50k; our categories stay well under that.
async function socrata(base, where) {
  const url = `${base}?$limit=50000&$where=${encodeURIComponent(where)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ojo-de-fuego data bundler (hackathon)' },
  });
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}`);
  }
  return res.json();
}

function collection(features, source, license) {
  return {
    type: 'FeatureCollection',
    properties: { source, license },
    features,
  };
}

function pointFeature(id, name, lon, lat, props) {
  return {
    type: 'Feature',
    id,
    properties: { id, name, ...props },
    geometry: { type: 'Point', coordinates: [lon, lat] },
  };
}

async function fetchHospitals() {
  const rows = await socrata(
    GENCAT_EQUIPAMENTS,
    "categoria LIKE '%3. Hospitals%'",
  );
  const features = [];
  for (const r of rows) {
    const lat = num(r.latitud);
    const lon = num(r.longitud);
    if (lat == null || lon == null) continue;
    features.push(
      pointFeature(`hosp-${r.idequipament}`, r.nom, lon, lat, {
        category: 'hospital',
        municipality: r.poblacio ?? null,
      }),
    );
  }
  return collection(
    features,
    'Generalitat de Catalunya, Equipaments de Catalunya (https://analisi.transparenciacatalunya.cat, dataset 8gmd-gz7i)',
    'Open data, Generalitat de Catalunya',
  );
}

// Regulated education levels keep schools of public interest; the dataset
// also lists private dance/music studios, which are irrelevant here.
const SCHOOL_LEVELS = [
  'EINF1C',
  'EINF2C',
  'EPRI',
  'ESO',
  'BATX',
  'CFPM',
  'CFPS',
  'EE',
];

async function fetchSchools() {
  const rows = await socrata(
    GENCAT_EQUIPAMENTS,
    "categoria LIKE 'Educació. Formació%'",
  );
  const features = [];
  for (const r of rows) {
    const lat = num(r.latitud);
    const lon = num(r.longitud);
    if (lat == null || lon == null) continue;
    const levels = SCHOOL_LEVELS.filter((l) => (r.categoria ?? '').includes(l));
    if (levels.length === 0) continue;
    features.push(
      pointFeature(`sch-${r.idequipament}`, r.nom, lon, lat, {
        category: 'school',
        municipality: r.poblacio ?? null,
        levels,
      }),
    );
  }
  return collection(
    features,
    'Generalitat de Catalunya, Equipaments de Catalunya (https://analisi.transparenciacatalunya.cat, dataset 8gmd-gz7i)',
    'Open data, Generalitat de Catalunya',
  );
}

async function fetchTowns() {
  const rows = await socrata(GENCAT_CAPS_MUNICIPI, '1=1');
  const features = rows
    .map((r) => {
      const lat = num(r.latitud);
      const lon = num(r.longitud);
      if (lat == null || lon == null) return null;
      return pointFeature(`town-${r.codi_municipi}`, r.cap_de_municipi, lon, lat, {
        category: 'town',
        municipality: r.municipi ?? null,
        county: r.comarca ?? null,
      });
    })
    .filter(Boolean);
  return collection(
    features,
    'Generalitat de Catalunya, Caps de municipi de Catalunya georeferenciats (https://analisi.transparenciacatalunya.cat, dataset wpyq-we8x)',
    'Open data, Generalitat de Catalunya',
  );
}

async function fetchPowerLines() {
  // High-voltage transmission lines (>= 110 kV), which matter for wildfire
  // triage. Lower-voltage distribution lines are far too numerous and dense
  // in towns to be informative on a globe.
  const query = `[out:json][timeout:300];
way["power"="line"]["voltage"](40.5,0.2,42.9,3.5);
out geom;`;
  // Server rejects the query outright with 406 while the rate-limit page is
  // up, so retry a few times with a pause.
  let res;
  for (let attempt = 1; attempt <= 5; attempt++) {
    res = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'ojo-de-fuego data bundler (hackathon)',
      },
      body: new URLSearchParams({ data: query }).toString(),
    });
    if (res.ok) break;
    console.warn(`overpass attempt ${attempt} -> ${res.status}, retrying in 30s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
  if (!res.ok) {
    throw new Error(`overpass -> ${res.status}`);
  }
  const data = await res.json();
  const features = [];
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const voltages = [...new Set(String(el.tags.voltage ?? '').split(';'))]
      .map(num)
      .filter((v) => v != null);
    const voltage = voltages.length > 0 ? Math.max(...voltages) : null;
    if (voltage == null || voltage < 110000) continue;
    const path = el.geometry
      .filter((p) => p.lon >= CAT.lonMin && p.lon <= CAT.lonMax && p.lat >= CAT.latMin && p.lat <= CAT.lonMax)
      .map((p) => [p.lon, p.lat]);
    if (path.length < 2) continue;
    features.push({
      type: 'Feature',
      id: el.id,
      properties: {
        id: `line-${el.id}`,
        name: el.tags.name ?? null,
        category: 'power-line',
        voltageKv: voltage / 1000,
        operator: el.tags.operator ?? el.tags['operator:short'] ?? null,
      },
      geometry: { type: 'LineString', coordinates: path },
    });
  }
  return collection(
    features,
    'OpenStreetMap power=line ways via Overpass API (https://overpass-api.de), Catalonia bbox',
    'ODbL 1.0, (c) OpenStreetMap contributors',
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const jobs = [
    ['hospitals.geojson', fetchHospitals],
    ['schools.geojson', fetchSchools],
    ['towns.geojson', fetchTowns],
    ['power-lines.geojson', fetchPowerLines],
  ];
  for (const [file, fetcher] of jobs) {
    const fc = await fetcher();
    await writeFile(path.join(OUT_DIR, file), JSON.stringify(fc) + '\n');
    console.log(`${file}: ${fc.features.length} features`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
