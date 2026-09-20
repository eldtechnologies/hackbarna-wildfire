---
id: 6ff3d134-a25b-40a4-8073-a1a2a33e3ef9
title: Ojo de Fuego — Wildfire Intelligence Console for Spain
author: Magnus Jonsson
tags: [hackathon, wildfire, design, hackbarna]
created_at: 2026-09-19T09:50:56Z
updated_at: 2026-09-19T09:50:56Z
---

# Ojo de Fuego — Wildfire Intelligence Console for Spain

## Overview

**Ojo de Fuego** ("Fire Eye") is a God's-Eye-View-style real-time intelligence console for wildfires in Spain, built for HackBarna 2026 (Sep 19–20, Norrsken House Barcelona).

It renders a cinematic 3D globe focused on the Iberian Peninsula with live wildfire data: satellite hotspots, active fire perimeters, and spread simulation. When a fire breaks out, an AI agent identifies the infrastructure and people at risk (hospitals, schools, towns, power lines) and recommends evacuation priorities.

**HackBarna tracks covered:** Monitoring active fires (primary) + Values at risk (secondary).

**Inspiration:** [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu — a spy-satellite simulator aesthetic on a photorealistic globe. We take the visual language (dark HUD, sensor looks, tracked targets, intelligence telemetry) but build a fresh, minimal codebase focused only on wildfire intelligence.

## Core Features

### F1. 3D Globe Console
- CesiumJS globe, default camera over Iberia, keyless Esri satellite imagery.
- Dark HUD chrome: corner brackets, telemetry readouts, layer toggles, UTC clock. Intelligence-console look, not a consumer map.
- Click-to-track a fire: camera locks on, metadata panel slides in, spread simulation starts.

### F2. Live Wildfire Layers
- **Hotspots:** satellite fire detections (Deepfire API / MTG data, refreshed ~every 10 min), rendered as pulsing markers sized/colored by fire radiative power.
- **Clusters:** Deepfire cluster groupings shown as bounding regions, so judges see signal processing, not raw dots.
- **Perimeters:** active fire polygons from Deepfire fire-spread endpoints, filled with animated heat gradient.
- **Spread simulation:** projected perimeter progression driven by Deepfire spread data (and/or simplified ELMFIRE-style propagation using wind direction), rendered as time-stepped ghost polygons.

### F3. Values at Risk Overlay
- Infrastructure layers from Generalitat de Catalunya / open data: hospitals, schools, towns, power infrastructure, roads.
- Threat ring analysis: for any selected fire, compute assets within buffer zones (5/10/20 km) of current perimeter and projected spread corridor.

### F4. Situation Agent
- LLM-powered agent panel: given a selected fire, summarizes the situation in plain language — perimeter size, spread direction, wind conditions, threatened assets ordered by severity, and evacuation recommendations ("Hospital de X lies 6 km downwind — prioritize").
- Grounded strictly in the computed threat data, not freeform hallucination: the agent receives a structured JSON situation packet.

### F5. Live-First with Cached Fallback
- Data provider abstraction with two sources: `live` (Deepfire API via server proxy) and `replay` (cached snapshots of a real recorded fire event).
- If the live API fails, rate-limits, or conference wifi dies, the app transparently replays a cached scenario. One toggle in the HUD shows data provenance ("LIVE" vs "REPLAY") so the demo is honest.

## Visual Direction

- **Palette:** near-black background (#0a0e12), HUD text in amber/cyan, fire layers in orange-red gradient, threat rings in warning yellow, infrastructure in cool cyan.
- **Aesthetic:** military console. Monospace HUD font (JetBrains Mono), thin 1px lines, corner-bracket framing, scanline/sensor-look post effect optional.
- **Motion:** hotspots pulse like radar contacts, spread polygons animate forward in time, camera moves are smooth tracked-target flights.

## Architecture

```
┌─────────────────────────────────────────┐
│  Browser (Vite + TypeScript + CesiumJS) │
│  ├── globe/      viewer, camera, layers │
│  ├── hud/        panels, toggles, clock │
│  ├── layers/     hotspots, perimeters,  │
│  │               spread, infrastructure │
│  └── agent/      situation panel UI     │
└──────────────┬──────────────────────────┘
               │ /api/*
┌──────────────▼──────────────────────────┐
│  Node proxy server (Express)            │
│  ├── deepfire client (API key, retry)   │
│  ├── snapshot cache (data/snapshots/)   │
│  ├── threat analysis (buffer geometry)  │
│  └── agent endpoint (LLM w/ JSON packet)│
└─────────────────────────────────────────┘
```

- **Frontend:** Vite + TypeScript + CesiumJS (same proven stack as gods-eye-view, minus their complexity).
- **Server:** thin Express proxy keeps the Deepfire API key out of the browser, normalizes responses, and serves cached snapshots.
- **Threat analysis:** server-side turf.js buffer/intersect computations over infrastructure GeoJSON.
- **Agent:** server endpoint that assembles a situation packet (fire metrics + threat list) and calls an LLM for the narrative. Deterministic data in, narrative out.

## Data Sources

| Source | Use | Access |
|---|---|---|
| Deepfire API | Hotspots, clusters, fire spread | API key (hackathon) |
| MTG satellite | Fire imagery refresher, every 10 min | Via Deepfire |
| Generalitat de Catalunya | Infrastructure GeoJSON (hospitals, schools, power) | Public download, bundled locally |
| ELMFIRE model | Spread model reference | Simplified propagation in-app |
| Google WeatherNext | Wind/weather for spread + agent context | API or cached |

## Milestones (2-day hackathon)

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
