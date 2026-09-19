# Data sources — what we have, what each gives, what it is for

A working index for the team. Every row was checked against a live endpoint or a downloaded file.
Status legend: **have** = data on disk or verified reachable · **key** = needs an API key · **blocked** = not usable in this environment.

Companion to the analysis in [`last-safe-departure.md`](last-safe-departure.md) (appendix A logs every experiment).

## 1. Quick index

| # | Source | Gives | Access | Status | Used for |
| --- | --- | --- | --- | --- | --- |
| 1 | **Deepfire API** | Hotspots, clusters, satellite perimeters, fire-spread simulations | Bearer token (free key) | key | The replay: hotspots, perimeters, clusters, spread (A1–A5, A7, A10) |
| 2 | **LSA SAF MTG FRP-Pixel** | 10-min geostationary fire detections + quality mask | Free, no key | have (77 GB) | The 10-minute layer; ignition gap; delivery latency (A6, A7) |
| 3 | **NASA FIRMS** | VIIRS 375 m + MODIS active fire, 24 h CSV | Free, **no key** for 24 h CSVs | have | Cross-check of Deepfire's fused layer (A7) |
| 4 | **EFFIS / GWIS (WMS)** | NRT burnt area, yearly/monthly burnt area, fuel map, FWI | Free WMS, no key | have | Ground-truth burnt area; fuel (A12) |
| 5 | **EUMETView (EUMETSAT)** | Sentinel-3 SLSTR FRP, MSG fire/cloud products | Free WMS, no key | have | Not used yet — extra imagery/FRP cross-check |
| 6 | **Copernicus EMS Rapid Mapping** | Official delineation vectors for major fires | Free | blocked (no activation matched) | Ground truth — fall back to press + EFFIS |
| 7 | **Open-Meteo — forecast** | Hourly ERA5 wind speed + gusts | Free, no key | have | Wind reconstruction (A9, A15) |
| 8 | **Open-Meteo — air quality** | PM2.5 (CAMS-backed) | Free, no key | have | Not used yet — shelter-in-place viability |
| 9 | **AEMET OpenData** | Hourly station obs, gusts, fire-risk maps, CAP warnings | Free key by email | key | Higher-quality local wind than ERA5 |
| 10 | **Google WeatherNext 3** | Hourly global ensemble, 5 km temp/hum, 10 km wind | Google Cloud (BigQuery / Earth Engine / GCS) | hackathon-provided | Not used yet — better wind for spread |
| 11 | **Copernicus DEM GLO-30** | 30 m elevation → slope | AWS Open Data, no key | have | Slope for the fallback model (A8, A15) |
| 12 | **ESA WorldCover** | 10 m land cover → fuel proxy | AWS Open Data, no key | have | Fuel for the fallback model (A8, A15) |
| 13 | **OpenStreetMap (local Overpass)** | Roads (incl. `track`), buildings, power lines, places | Local instance, no key | have | Road graph (14,819 nodes), cut times, buildings (A10, A11, A13) |
| 14 | **Catastro INSPIRE** | Building footprints + `currentUse`, per municipality | WFS, free | have | Values at risk — **solved** (A13) |
| 15 | **INE padrón** | Population + foreign nationality by municipality | Free download | have | Pocket population; alert languages — **solved** (A13) |
| 16 | **Generalitat de Catalunya** | Fire perimeters, emergency regions, firefighter stations, Pla Alfa | Free | have | Catalan demo context; infrastructure |
| 17 | **OpenCelliD** | Cell tower positions | Free key, CC-BY-SA | key | ES-Alert footprint simulation (over-alerting) |
| 18 | **REGA** | Livestock holdings | Public registry | blocked (no open endpoint found) | People who return for animals |
| 19 | **TypeSafe / Jev** | Typed-answer verification of alert phrasings | Bearer key (waitlist) | key | Selection + verification gate for message text |
| 20 | **Pyronear `pyro-sdis`** | 33.6 k tower-camera images, YOLO smoke boxes | HuggingFace, Apache-2.0 | hackathon-provided | Early-detection track only (French towers) |
| 21 | **ELMFIRE** | Fire-spread model | Open source | hackathon-provided | Reached through the Deepfire API |

## 2. Where each source was decisive

| Question | Source that answered it |
| --- | --- |
| When did the fire start, and from what? | Deepfire hotspots (2,660, 7 sources) + MTG |
| Where were the active perimeters? | Deepfire `satellite-perimeters` (12 snapshots) |
| Can spread run in Spain? | Deepfire fire-spread API (ELMFIRE + ForeFire) |
| What is the 10-minute layer worth? | MTG — flags the exit road at 19:38 CEST vs 00:03 without it |
| Where did detection break down? | MTG archive — a **100-min** ignition gap; a 40-min cloud gap |
| How late is a detection actionable? | MTG archive file timestamps — **median ~17 min** |
| Is Deepfire's perimeter right? | EFFIS burnt area — 5,767 ha vs Deepfire 9,172 ha (IoU 0.61) |
| What drove the fire? | Open-Meteo ERA5 — southerly gusting 54 km/h, RH 10 % |
| Which road closed first? | OSM road graph + Deepfire hotspots — AL-6109 at 19:38 CEST |
| Where are the people? | Catastro buildings + INE padrón |
| Was the alert reachable? | OpenCelliD towers (planned) |

## 3. What we actually have on disk

| Asset | Path | Size |
| --- | --- | --- |
| MTG 2026 archive (73,630 files / 36,815 scans) | `~/Documents/Codex/2026-09-19/file-users-ola-downloads-hackbarna-20/outputs/LSA_SAF_MTFRPPixel_2026/` | 77 GB |
| — Iberia extract (246,528 obs) | `…/analysis/iberia_bbox_hotspots.csv.gz` | 11 MB |
| — Los Gallardos extract (1,932 obs) | `…/analysis/los_gallardos_2026-07-09_12.geojson` | 0.9 MB |
| Deepfire replay snapshot | `data/snapshots/castelltallat-2025.json` | — |
| Andalucía OSM extract | `/tmp/df/osm/andalucia.osm.pbf` | 194 MB |
| Local Overpass DB | docker volume `opdb` | ~4.5 GB |

## 4. Local services we run

| Service | How | Endpoint |
| --- | --- | --- |
| Overpass API (Andalucía) | `docker start ovp` | `http://127.0.0.1:12345/api/interpreter` |
| Express proxy + Vite client | `npm run dev` | `http://localhost:5173` |

## 5. Keys still needed

**Deepfire** · **AEMET** · **OpenCelliD** · **Copernicus Data Space** · **EUMETSAT Data Store** · **TypeSafe/Jev** (waitlist).

## 6. Traps and limits (read before you build on a source)

- **Catastro** — the bbox must be **small (~500 m per side)**; larger boxes return *"Area of extension out of limits"*. Query with `TYPENAMES=bu:Building` and CRS `EPSG:25830`. Tile a municipality in boxes.
- **OSM in rural Almería** — sparse. Only **3 buildings within 1 km of Bédar**; do not use it for values at risk. The roads people die on are often the ones missing from the data you reach for first.
- **INE mobile-phone mobility** — areas have ≥5,000 residents, roaming phones are excluded, and it is historical. Use as a seasonal multiplier only.
- **OpenCelliD** — crowd-sourced and incomplete in rural Spain. Present the footprint as an approximation.
- **MTG** — a detection gap is not evidence the fire stopped (cloud causes gaps). Missing FRP stays null, never zero.
- **EFFIS burnt area** — the seasonal `modis.ba.poly.season` layer is not event-dated; comparisons are indicative.
- **FIRMS vs Deepfire** — same lineage (Deepfire ingests these), not independent confirmation.
- **Overpass mirrors** — the corporate proxy blocks the public instances. Use the local instance.

*All figures above are the ones recorded in the spike; see `last-safe-departure.md` appendix A for method and caveats.*