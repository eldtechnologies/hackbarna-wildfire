// Latency harness for the egress build. This is the measurement behind the acceptance
// criterion "a request still answers within the existing latency budget, measured before
// and after", so it is committed rather than run ad hoc — a number quoted in a PR has to
// be reproducible by whoever reads it.
//
// What it measures is `buildEgress`, not the context load. The context parses the capture,
// indexes the detections against the graph and runs the twelve-configuration cut-field
// sweep once at startup, and the routes warm it deliberately so the first scrub is not a
// stall. That cost is real but it is paid once per process, so folding it into the
// per-request figure would misstate what a scrubber actually experiences.
//
// The cursors below are the ones a demo scrubber revisits: the start of the window, the
// hours around the Bédar cut at 19:38 CEST, and the end. A cold cursor and a repeated one
// both matter — the route layer memoises responses, so the second visit to a cursor is
// what the cache is for.

import { buildEgress, loadContext } from '../server/engine/egress';

/** Seconds since the scenario origin. */
const CURSORS: Array<number | undefined> = [
  undefined,
  0,
  3600,
  7200,
  10800,
  14400,
  21600,
  28800,
];

const contextStart = Date.now();
loadContext();
const contextMs = Date.now() - contextStart;
console.log(`context load (once per process, not per request): ${contextMs} ms`);

const samples: number[] = [];
for (const at of CURSORS) {
  const started = Date.now();
  const built = buildEgress(at === undefined ? {} : { atSeconds: at });
  const ms = Date.now() - started;
  samples.push(ms);
  const pocket = built.response.pockets[0];
  const routes = pocket?.routes.length ?? 0;
  console.log(
    `  at=${String(at).padStart(8)}  ${String(ms).padStart(5)} ms  ` +
      `routes=${routes}  verdict=${pocket?.verdict ?? 'none'}`,
  );
}

samples.sort((a, b) => a - b);
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const median = samples[samples.length >> 1];
console.log(
  `buildEgress  mean=${mean.toFixed(0)} ms  median=${median} ms  ` +
    `min=${samples[0]} ms  max=${samples[samples.length - 1]} ms  n=${samples.length}`,
);

// Compared against the figure measured on main at 4a648d7 before this change: mean 156 ms
// over these same eight cursors. Printed rather than asserted — a wall-clock bound in a
// test is a flake, and the honest way to hold this is to look at the two numbers together.
const BASELINE_MEAN_MS = 156;
const ratio = mean / BASELINE_MEAN_MS;
console.log(
  `against the 4a648d7 baseline of ${BASELINE_MEAN_MS} ms: ` +
    `${ratio.toFixed(2)}x (${mean >= BASELINE_MEAN_MS ? '+' : ''}${(mean - BASELINE_MEAN_MS).toFixed(0)} ms)`,
);
