// Regression tests for replay frame selection and the timeline block. Run
// with the rest of the suite: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';
import { frameAt, buildTimeline } from './replay';

const frame = (t: string) => ({ t, hotspots: [], clusters: [], perimeters: [] });

const FRAMES = [
  frame('2026-09-19T13:55:00.000Z'),
  frame('2026-09-19T13:55:15.000Z'),
  frame('2026-09-19T13:55:30.500Z'),
];

test('frameAt returns the latest frame at or before the cursor', () => {
  assert.equal(frameAt(FRAMES, 0).t, FRAMES[0].t);
  assert.equal(frameAt(FRAMES, 14.9).t, FRAMES[0].t);
  assert.equal(frameAt(FRAMES, 15).t, FRAMES[1].t);
  assert.equal(frameAt(FRAMES, 31).t, FRAMES[2].t);
});

test('frameAt clamps below the first frame and beyond the last', () => {
  assert.equal(frameAt(FRAMES, -5).t, FRAMES[0].t);
  assert.equal(frameAt(FRAMES, 99999).t, FRAMES[2].t);
});

test('frameAt tolerates unsorted recordings', () => {
  const shuffled = [FRAMES[2], FRAMES[0], FRAMES[1]];
  assert.equal(frameAt(shuffled, 16).t, FRAMES[1].t);
});

test('durationSeconds ceils so at=durationSeconds reaches the final frame', () => {
  // Regression: Math.round turned the drill's 105.037 s span into 105, which
  // left the last frame unreachable for a scrubber bounded by the timeline.
  const timeline = buildTimeline('test', FRAMES);
  assert.equal(timeline.durationSeconds, 31);
  assert.equal(frameAt(FRAMES, timeline.durationSeconds).t, FRAMES[2].t);
});
