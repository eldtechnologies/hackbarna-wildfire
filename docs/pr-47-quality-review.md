# Norma review dispositions for PR #47

The [Norma comment](https://github.com/eldtechnologies/hackbarna-wildfire/pull/47#issuecomment-5749395235)
reported 64 introduced findings on `459ec2c`, exposing only the ten most severe. All ten
visible findings use the rule **Async Operation Without Error Handling**. Locations below
refer to that report's revision, not line numbers after the cleanup.

| Reported location | Disposition |
| --- | --- |
| `server/providers/coalescing.test.ts:16,21` | Handled by the async `node:test` callback. A rejected provider read fails the test. The surrounding test verifies failed requests are evicted and retried. |
| `server/providers/live-deadline.test.ts:6,27` | Dynamic imports run inside async test callbacks. Import failure rejects the test rather than escaping unhandled. |
| `server/providers/live-deadline.test.ts:19,41` | `assert.rejects` explicitly handles and verifies the expected cancellation rejection. |
| `server/providers/live-deadline.test.ts:22` | `Promise.resolve()` cannot reject here; it drains a microtask before the no-extra-requests assertion. |
| `server/providers/live.ts:140` | `fetchPage` propagates errors to the retry handler in `fetchPaged`. Its `finally` clears the timer on success or failure. |
| `server/providers/live.ts:222` | `fetchWindowed` propagates errors to `LiveProvider.getFires`, which clears its deadline and aborts sibling requests in `finally`; `readSource` catches the failure and serves the pinned real replay. |
| `server/providers/live.ts:240` | The awaited `Promise.all` propagates rejection through the same fallback boundary. If replay also fails, the HTTP route catches the failure, logs it and returns 502. |

These ten are false positives in context. No blanket catches, swallowed failures, rule
suppressions or disabled checks were added. Existing tests cover coalesced failure and
retry, cancellation during fetch and backoff, real-replay fallback, and visible UI errors.

The Castelltallat recording, mock generator, exercise clock helper, source option, report
branches and exercise screenshots have been removed. Remaining source/race tests use the
real replay or minimal isolated fixtures. A regression test verifies that an old recording
explicitly marked as exercise data is rejected rather than relabelled as satellite observations.

## Verification

- TypeScript checks pass.
- All 373 tests pass, including live deadline and error-handling regression tests.
- Production build passes.
- Browser inspection confirms the exercise option is absent and Los Gallardos loads with
  satellite imagery, recorded observations and computed asset/report data.

## Access limitation

The [full report](https://norma.qualityclouds.com/projects/10160) requires sign-in. The other
54 findings were not exposed by the GitHub comment and remain unreviewed. None have been
marked resolved or dismissed in Norma. A signed-in session or full report export is needed
to complete that part of the review.
