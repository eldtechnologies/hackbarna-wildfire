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
// ## Reading the number
//
// Wall-clock on a shared machine, and the run-to-run spread is large — repeated runs of a
// single revision here have ranged from a 161 ms mean to a 354 ms one. A single comparison
// against a baseline recorded at another moment is therefore not a signal on its own.
//
// So pass the baseline in, and obtain it the same way on the revision you are comparing
// against, on the same machine and in the same session:
//
//     node --import tsx scripts/bench-egress.mts > /tmp/after.txt
//     git stash && node --import tsx scripts/bench-egress.mts > /tmp/before.txt && git stash pop
//     node --import tsx scripts/bench-egress.mts --baseline-ms=$(prior mean from /tmp/before.txt)
//
// The scenario origin for the committed capture is 00:00Z on 9 July, so a cursor of
// 63,600 s is 19:40 CEST — just past the AL-6109 cut — and the cursors below are chosen to
// span the transition rather than to sit entirely in one verdict state.

import { buildEgress, loadContext } from '../server/engine/egress';

/**
 * Seconds since the scenario origin (2026-07-09T00:00:00Z).
 *
 * `undefined` is the default cursor, the end of the window. The rest walk from before any
 * detection has arrived, through the hours where a route is known and open, and across the
 * cut at 63,480 s — the state where the band is finite and the gate is actually consulted.
 * A set that stopped at 28,800 s sampled the ungated path seven times out of eight.
 */
const CURSORS: Array<number | undefined> = [
  undefined,
  0,
  14400,
  28800,
  57600,
  63000,
  63600,
  64800,
  72000,
];

/** The baseline mean in ms, if the caller recorded one. */
function baselineFromArgv(): number | null {
  const arg = process.argv.find((a) => a.startsWith('--baseline-ms='));
  if (arg === undefined) return null;
  const value = Number(arg.slice('--baseline-ms='.length));
  return Number.isFinite(value) && value > 0 ? value : null;
}

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
  const usable = pocket?.routes.filter((r) => r.usable).length ?? 0;
  console.log(
    `  at=${String(at).padStart(8)}  ${String(ms).padStart(5)} ms  ` +
      `routes=${routes} usable=${usable}  verdict=${pocket?.verdict ?? 'none'}`,
  );
}

samples.sort((a, b) => a - b);
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
const median = samples[samples.length >> 1];
console.log(
  `buildEgress  mean=${mean.toFixed(0)} ms  median=${median} ms  ` +
    `min=${samples[0]} ms  max=${samples[samples.length - 1]} ms  n=${samples.length}`,
);

const baseline = baselineFromArgv();
if (baseline === null) {
  console.log(
    '\nNo baseline given, so this run says nothing about a change on its own. Re-run with\n' +
      '--baseline-ms=<mean from the revision you are comparing against, measured on this\n' +
      'machine in this session>. The run-to-run spread here is wide enough that a baseline\n' +
      'recorded at another moment is not a comparison.',
  );
} else {
  const ratio = mean / baseline;
  console.log(
    `\nagainst a baseline of ${baseline} ms measured in this session: ` +
      `${ratio.toFixed(2)}x (${mean >= baseline ? '+' : ''}${(mean - baseline).toFixed(0)} ms)`,
  );
}
