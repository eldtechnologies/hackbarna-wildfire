# Ojo de Fuego — Wildfire Intelligence Console for Spain

> **Original product concept, not an as-built description.** For what the service does today, use
> the [README](../README.md) and the [API reference](API.md); for the evidence and the
> road-decision boundaries, use [work-plan.md](work-plan.md). Feature sections below are marked
> where they diverge from what shipped.

## Overview

**Ojo de Fuego** ("Fire Eye") is a God's-Eye-View-style real-time intelligence console for wildfires in Spain, built for HackBarna 2026 (Sep 19–20, Norrsken House Barcelona).

It renders a cinematic 3D globe focused on the Iberian Peninsula with live wildfire data: satellite hotspots, active fire perimeters, and spread simulation. When a fire breaks out, an AI agent identifies the infrastructure and people at risk (hospitals, schools, towns, power lines) and recommends evacuation priorities.

**HackBarna tracks covered:** Monitoring active fires (primary) + Values at risk (secondary).

**Inspiration:** [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu — a spy-satellite simulator aesthetic on a photorealistic globe. We take the visual language (dark HUD, sensor looks, tracked targets, intelligence telemetry) but build a fresh, minimal codebase focused only on wildfire intelligence.

## Core Features

### F1. 3D Globe Console
- CesiumJS globe, default camera over Iberia, keyless Esri satellite imagery.
- Dark HUD chrome: corner brackets, telemetry readouts, layer toggles, UTC clock. Intelligence-console look, not a consumer map.
- Click-to-track a fire: camera locks on, the threat and situation panels open, and the spread
  scrubber appears.

### F2. Live Wildfire Layers
- **Hotspots:** satellite fire detections (Deepfire API / MTG data, refreshed ~every 10 min), rendered as pulsing markers sized/colored by fire radiative power.
- **Clusters:** Deepfire cluster groupings shown as bounding regions, so judges see signal processing, not raw dots.
- **Perimeters:** observed fire polygons from the Deepfire `satellite-perimeters` collection, filled with animated heat gradient.
- **Spread simulation:** projected perimeter progression **computed in-app**, not from Deepfire. The OGC API exposes observed perimeters only - there is no spread or forecast collection - so `src/fires/spreadModel.ts` interpolates the observed perimeter forward from its own centroid drift. Calling this "Deepfire spread data" would claim a source that does not exist.

### F3. Values at Risk Overlay
- Infrastructure layers from Generalitat de Catalunya / open data: hospitals, schools, towns, power infrastructure, roads.
- Threat ring analysis: for any selected fire, compute assets within buffer zones (5/10/20 km) of current perimeter and projected spread corridor.

### F4. Situation Agent
- Situation panel: given a selected fire, presents the perimeter size, derived spread heading, threatened assets and proximity priorities as server-rendered facts.
- Grounded strictly in computed geometry, never freeform generation: the server assembles a structured situation packet and every rendered number and name comes from it. An optional chat-completions model may only return an ordering of the supplied fact IDs, and any invalid, missing or invented ID falls back to the deterministic order. With no key, the panel works with no model call at all.
- Spread direction note: the fire schema has no measured wind field, so the packet's spread direction is the drift heading computed from the perimeter centroid toward the furthest spread projection, not a measured wind. A live wind feed (WeatherNext is the planned source) is a follow-up.

### F5. Live-First with Cached Fallback
- Data provider abstraction with two sources: `live` (Deepfire API via server proxy) and `replay` (cached snapshots of a real recorded fire event).
- If the live API fails, rate-limits, or conference wifi dies, the app transparently replays a cached scenario. The HUD badge shows data provenance ("LIVE" vs "REPLAY"). It is not a toggle: it reports the `provenance` field of the last response, so it cannot claim live data that did not arrive.

## Visual Direction

- **Palette:** near-black background (#0a0e12), HUD text in amber/cyan, fire layers in orange-red gradient, threat rings in warning yellow, infrastructure in cool cyan.
- **Aesthetic:** military console. Monospace HUD font (JetBrains Mono), thin 1px lines, corner-bracket framing, scanline/sensor-look post effect optional.
- **Motion:** hotspots pulse like radar contacts, spread polygons animate forward in time, camera moves are smooth tracked-target flights.

## Architecture

```
┌─────────────────────────────────────────┐
│  Browser (Vite + TypeScript + CesiumJS) │
│  ├── globe/      viewer, camera         │
│  ├── hud/        panels, legend, clock  │
│  ├── fires/      perimeters, spread sim │
│  └── layers/     hotspots, clusters,    │
│                  infrastructure         │
└──────────────┬──────────────────────────┘
               │ /api/*  (4 routes)
┌──────────────▼──────────────────────────┐
│  Node proxy server (Express)            │
│  ├── providers/  live + replay,         │
│  │               normalizer, latency    │
│  ├── threats.ts  buffer geometry        │
│  ├── situation   facts + optional order │
│  ├── engine/     road egress, CAP,      │
│  │               ledger                 │
│  ├── model/      growth, thermal        │
│  │               forecasts              │
│  └── reach.ts    over-alerting figure   │
└─────────────────────────────────────────┘
```

- **Frontend:** Vite + TypeScript + CesiumJS (same proven stack as gods-eye-view, minus their complexity).
- **Server:** thin Express proxy keeps the Deepfire API key out of the browser, normalizes responses, and serves cached snapshots. Thirteen `GET` routes in total; the console calls four.
- **Threat analysis:** server-side turf.js buffer/intersect computations over infrastructure GeoJSON.
- **Agent:** server endpoint that assembles a situation packet (fire metrics + threat list) and renders it. An optional model may only order the supplied fact IDs. Deterministic data in, deterministic prose out.

## Data Sources

| Source | Use | Access | Status |
|---|---|---|---|
| Deepfire API | Hotspots, clusters, observed (`satellite`) perimeters | Bearer token (hackathon) | implemented |
| MTG satellite | Fire imagery refresher, every 10 min | Via Deepfire | arrives through Deepfire's fused layer, not a separate feed |
| Generalitat de Catalunya | Infrastructure GeoJSON (hospitals, schools, power) | Public download, bundled locally | implemented, Catalonia only |
| OpenStreetMap | Power lines, the road graph | Bundled fetches | implemented |
| Catastro INSPIRE + INE padrón | Building footprints, population | Bundled fetches | implemented |
| OpenCelliD | Cell tower footprints | Free key, CC-BY-SA | implemented as a committed fixture |
| ELMFIRE model | Spread model reference | Open source | **not implemented** — the in-app projection interpolates provider-supplied spread polygons |
| Google WeatherNext | Wind/weather for spread + agent context | Hackathon-provided | **not implemented**; no live wind feed exists |

## Planned milestones (2-day hackathon)

The schedule as it was planned before the event. What actually shipped is in
[work-plan.md](work-plan.md) and the [README](../README.md).

**M1 — Day 1 morning:** Scaffold + globe + HUD shell. Camera over Iberia.
**M2 — Day 1 afternoon:** Provider layer + hotspots + perimeters live on globe.
**M3 — Day 1 evening:** Spread simulation + threat rings + infrastructure overlay.
**M4 — Day 2 morning:** Situation agent + recommendations panel.
**M5 — Day 2 afternoon:** Cached replay mode, demo polish, rehearsal scenario locked.

**Demo narrative:** open on Iberia live → hotspot flashes in Catalunya → click to track → perimeter + spread simulation → agent panel: "2 hospitals, 4 schools, 12,000 residents in the spread corridor" → evacuation priority list → toggle to REPLAY to show robustness.

## Risks

- **R1. Deepfire API access/spec unknown until event.** Mitigation: provider abstraction + cached replay from day one; mock the API from the public description.
- **R2. No active fire during demo.** Mitigation: replay mode is a feature (historical fire playback), not just a fallback.
- **R3. LLM agent hallucination.** Mitigation: agent only narrates a structured packet; numbers come from computed geometry, never the model.
