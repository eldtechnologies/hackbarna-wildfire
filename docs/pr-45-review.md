# PR #45 review resolution

Daniel's review was made at `d2bde48`. These changes also cover the newer paired-comparison code. Norma was assessed from its GitHub comment, as requested; its private report was not available.

| Finding | Resolution |
| --- | --- |
| F1: unsafe checkpoint loading | Both audit runners share the restricted, weights-only loader. A regression rejects object-bearing checkpoints. |
| F2: malformed success responses appear empty | The fire client rejects missing collections, invalid provenance and invalid fetch timestamps. Truly empty, complete responses remain valid. |
| F3: first-load error claims retained data | First-load failures show a HUD alert and say that no observations loaded. Later failures retain the prior frame and show Retry. |
| F4: empty infrastructure appears available | Files with no usable assets count as failed. A wholly empty bundle is unavailable; partial bundles are marked incomplete. |
| F5: missing per-event evidence | `validation/full-results.json` now contains all episode metrics. The paired comparison also includes its frozen bundle, file inventory and case results. The earlier assessment links to the later comparison. |
| F6: forward control untested | DOM tests click both directions and verify exact hour steps and end clamping. |
| F7: unpinned regional counts | Tests pin all four Almería counts and the retained Catalonia counts. |
| F8: snapshot note untested | Server fact text and the rendered situation panel both have note assertions. |
| F9: stale, mislabeled screenshots | Replaced the old captures with a correctly named JPEG of the current 465-match Almería state, linked from the README. |
| F10: partial source identity | Audit runners copy the complete locked trainer package into a private import directory. They do not put the supplied trainer root on the import path. The paired adapter executes checked source bytes. |
| F11: destructive or mixed imports | The importer requires all baseline categories, preserves their non-Almería features, and publishes a complete bundle to a fresh directory with one rename. Failure leaves the baseline intact. |
| F12: live response accepted for historical seek | Every explicit cursor requires a matching replay timestamp. Failure preserves the committed frame and retry cursor. |
| F13: duplicate threat requests untested | The real selection-layer test repeats the same evidence key and asserts one request. |
| F14: weak boundary and audit tests | Tests pin fractional times, timeline consistency, exact threshold inclusion, deterministic bootstrap output, unavailable-input poisoning, importer failure, frozen-input identity and polygon-hour scoring. |
| F15: app cursor ordering untested | The entry point uses `connectFireViews`; an integration test with real layers verifies both threat and situation requests use the newly committed cursor. |
| F16: inconsistent forecast time display | Forecast origin uses the same `formatClock` function as the valid-time label. |
| F17: coverage rectangle can drift | Tests compare the server rectangle, importer rectangle, provenance file and all four GeoJSON metadata records. |
| F18: situation summary clipped | Replay occupies the lower left; the right column extends below its old boundary. Verified at 1280×720: the entire summary and its operational warning are visible. |
| F19: mixed historical commit subjects | Existing published history is retained. The requested squash merge supplies one conventional final subject. |
| F20: non-conventional PR title | The PR title is updated to a conventional `feat:` subject. No issue-closing claim is added. |

## Norma's visible async findings

The ten visible warnings all report `await` without a local catch. The calls in `server/infrastructure.test.ts` and `tests/playback-ui.test.ts` are awaited by the Node test runner; rejection must fail the test. Catching and suppressing them would hide failures.

`fetchFires` propagates transport, JSON and envelope errors to `FirePlayback.load`, which catches them, keeps the last committed frame, and exposes an error/retry state. `start`, `seek`, `play` and `retry` delegate to that same boundary. Regression tests exercise initial failures, failed seeks, stale responses, malformed payloads and recovery. Repeating a catch at each forwarding method would not improve error handling.

## Independent Magnus review

The first Python pass required restricted loading, complete source/input identity, complete published evidence and safe importer publication. Those changes and regression tests are included.

The next application pass found one more defect: a live request that temporarily received replay fallback stopped polling. Refresh and cached-page restoration now follow request intent (no cursor means latest), rather than response provenance. Explicit replay seeks remain paused. Latest polling also retains automatic retries after transport failures. Tests cover live → fallback → live recovery, initial and later network failures, pause cancellation and page restoration.

Validation results and the final independent verdict are recorded in the PR description after verification completes. Model predictions, historical protocols and reported scores are unchanged; the frozen model remains experimental.


Verification: 360 Node tests and 12 Python tests pass. Typecheck and production build pass. Eighteen isolated mutations each make their intended regression test fail. The Python reviewer independently reproduces all 38 cached predictions, 152 rasters, 2,128 confusion-count sets and aggregate summaries; it does not claim a new full raw-archive or PBF reconstruction.
