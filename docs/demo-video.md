# Demo video: script as recorded, and how it was shot

Team: **Radical AI** · HackBarna 2026 · Final cut: 2:34, 1080p60, AI voiceover.
The MP4 is a release asset, not in git: [release `demo-video-2026-09-20`](https://github.com/eldtechnologies/hackbarna-wildfire/releases/tag/demo-video-2026-09-20) ·
[direct download](https://github.com/eldtechnologies/hackbarna-wildfire/releases/download/demo-video-2026-09-20/ojo-de-fuego-demo.mp4).

This page records what was actually shot on 2026-09-20, which differs from the original
shot list in a few places. Read "What the footage shows" before quoting the video.

## What the footage shows

| Time | Beat | Source |
| --- | --- | --- |
| 0:00 | Title card, team photo | still |
| 0:12 | Problem: Los Gallardos, road AL-6109 cut 1 h 22 m before the first deaths | `docs/img/17_falsification_test.png` |
| 0:33 | Iberia globe, push-in | live app, Los Gallardos capture |
| 0:36 | Select fire, tracked flight, spread playback T+0 to T+8 h | live app, **synthetic drill** |
| 0:48 | Threat rings 5 / 10 / 20 km, 176 assets | live app, **synthetic drill** |
| 1:01 | Situation agent, badge `AI ORDERED FACTS` | live app, **synthetic drill**, Qwen3-30B on Nebius |
| 1:10 | FLIR look, then agent close-up | live app, **synthetic drill** |
| 1:28 | Own model: accuracy summary | `docs/screenshots/model-accuracy-summary.png` |
| 1:45 | Where it stands: not ahead of DeepFire yet, v3 training | `docs/screenshots/model-forecast-examples.png` |
| 2:01 | REPLAY provenance badge, then observation replay at 8x | live app, **real** Los Gallardos capture |
| 2:16 | Closing plate and end card | live app, synthetic drill |

Two things a viewer could misread:

- **The Castelltallat fire is a synthetic exercise, not an observed fire.** It was shot because
  the real Los Gallardos capture has no spread frames, so spread playback, the projected
  corridor and the 8-hour ghost cannot be shown with it. The voiceover line "a recording of a
  real fire capture" plays over the Los Gallardos replay only, where it is true.
- **The green FLIR look is not on `main`.** It comes from commit `4565afb` plus a GLSL fix
  and exists only on the footage branch. `main` ships a different SENSOR toggle (#47), a
  grayscale filter labelled "visual filter, not thermal imagery".

## Voiceover as recorded

1. "Hi, we're Radical AI. At HackBarna 2026 we took on the wildfire challenge, and we built Ojo
   de Fuego, a real-time wildfire intelligence console for Spain."
2. "This July, fourteen people died at Los Gallardos, Almería. Not in their homes, on the road
   out. The fire reached the escape road before it reached the village, and no alert was sent.
   Detection isn't the bottleneck anymore. The gap is between seeing a fire and knowing what to
   do about it."
3. "Ojo de Fuego covers three use cases in one console. First, monitoring: live satellite
   hotspots, clustered into fires, with animated perimeters and a spread simulation you can
   scrub forward in time."
4. "Second, values at risk: hospitals, schools, towns and power lines, with threat rings at
   five, ten and twenty kilometres computed against the live perimeter, plus the projected
   spread corridor."
5. "Third, decision support: our situation agent turns the geometry into a plain-language
   report with evacuation priorities."
6. "Everything runs on open weights. The situation agent narrates through open-weight models on
   Nebius Token Factory, and the model is swappable: one config switch moves between DeepSeek,
   Qwen or Llama, no code change, with a deterministic template fallback so the console never
   goes silent."
7. "We also trained our own model: a causal U-Net forecasting thermal spread from MTG satellite
   frames, with audited training data and an acceptance harness, so no forecast ships without
   passing evaluation. Galtea and Quality Clouds gave us the evaluation and quality gates
   around it."
8. "And we're honest about where it stands: our head-to-head against DeepFire's forecast showed
   we don't beat it yet. Version three is training now. What we can say is that every number
   this console shows comes from measured geometry, never from a language model."
9. "Demos die on conference wifi, so ours can't. Every response carries provenance, live or
   replay, and the console falls back to a cached real fire transparently. This is a recording
   of a real fire capture."
10. "Ojo de Fuego: from satellite pixel to evacuation priority, in one console, on open models.
    Built by Radical AI at HackBarna 2026. Thank you."

Line 8 is its own audio clip. If v3 lands, replace that one sentence with the measured figure
and name the held-out protocol; nothing else needs re-cutting.

Line 6 overstates one thing: the switch is config-only, but not every model works. See below.

## What broke while recording, and why

- **The drill snapshot rendered nothing.** Causal replay (#44) drops detections whose
  `observed_at` is later than the frame time. The drill was recorded against the mock with an
  accelerated clock (frames 13:53 to 13:55 wall time, `observed_at` 13:59 to 17:30), and its
  spread frames had no `issued_at`. The footage branch carries a patched copy with frame times
  rebased to the simulated clock. `main` has since removed synthetic recordings and rejects any
  recording whose `dataKind` is not `observations`, so this is not a path for `main`.
- **Los Gallardos has assets now.** The old note "0 threatened assets, outside the infra
  bundle" is outdated since the Almería infrastructure landed: 465 assets, 21 inside the
  perimeter.
- **The narrator fell back to the template with no log line.** `narration.ts` swallows every
  failure by design. Two separate causes:
  - DeepSeek-V4.1-Flash is a reasoning model. With `max_completion_tokens: 128` it returned
    `reasoning_tokens: 128`, `finish_reason: length`, empty content, in 16 s.
  - Qwen3-30B-A3B-Instruct returns valid JSON, but the first call after idle took 22 s
    against a 4 s wait and a 15 s abort. Warm, it answers inside the budget.
  `scripts/llm-check.mjs` reproduces both without printing credentials.
- **The FLIR toggle crashed Cesium.** `sensorLook.ts` mixed GLSL ES 1.00 (`varying`,
  `gl_FragColor`) into a stage Cesium 1.145 compiles as GLSL ES 3.00. Fixed on the footage
  branch with `in` and `out_FragColor`.
- **A hidden tab renders a black globe.** Chrome pauses `requestAnimationFrame` for
  background tabs, so imagery tiles never load. The tab must be frontmost before judging the
  globe.

## Re-shooting

1. Footage branch: `demo/recording` (local; carries `4565afb`, the GLSL fix and the patched
   drill). Run the real-capture beats with
   `DATA_MODE=replay REPLAY_SNAPSHOT=los-gallardos-2026-07-09.json npm run dev`, then restart
   on `REPLAY_SNAPSHOT=castelltallat-drill-causal-demo.json` for the spread beats.
2. Set `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` for a non-reasoning model and confirm with
   `node --env-file=.env scripts/llm-check.mjs`. Select a fire once as a throwaway to warm the
   model, wait a minute for the failed result to leave the 60 s cache, then shoot the agent
   beat. The badge must read `AI ORDERED FACTS`, not `COMPUTED FACTS`.
3. Record the whole screen in one take and cut afterwards. Log wall-clock times per action;
   the HUD clock in the frame makes alignment exact.
4. Full-screen Chrome on a 1512x982 display gives a 1.69:1 page. Pad the sides with
   `#0a0e12` instead of cropping, so the Cesium and Esri attribution stays in frame.
