import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointToSegmentMetres,
  polylineDistanceMetres,
  polylineLengthMetres,
  ringIsClosed,
  ringSignedAreaM2,
  bboxOf,
  bboxPad,
  metresBetween,
} from './geometry';
import type { LatLon } from '../../shared/fires';

const p = (lat: number, lon: number): LatLon => ({ lat, lon });

test('distance is metres, not degrees', () => {
  // At 37 N a degree of longitude is ~89 km, so 0.0018 deg is ~160 m. A units bug
  // comparing degrees against a metre radius reports "inside" for every radius.
  const d = pointToSegmentMetres(p(37.0, -2.0), p(37.0, -2.0018), p(37.0, -2.0018));
  assert.ok(Math.abs(d - 160.2) < 1.0, `expected ~160 m, got ${d}`);
});

test('latitude and longitude use different scales', () => {
  const east = pointToSegmentMetres(p(37.0, -2.0), p(37.0, -1.9982), p(37.0, -1.9982));
  const north = pointToSegmentMetres(p(37.0, -2.0), p(37.0018, -2.0), p(37.0018, -2.0));
  assert.ok(Math.abs(east - 160.2) < 1.0, `east: ${east}`);
  assert.ok(Math.abs(north - 199.8) < 1.0, `north: ${north}`);
  // A single isotropic scale would make these equal; they differ by ~25%.
  assert.ok(north - east > 35, 'a degree of latitude is longer than a degree of longitude here');
});

test('distance to a segment endpoint is zero, not the segment length', () => {
  // Guards against an implementation that measures to the segment's far end.
  const a = p(37.0, -2.0);
  const b = p(37.0, -2.002);
  assert.ok(polylineDistanceMetres(b, [a, b]) < 0.001);
  assert.ok(polylineDistanceMetres(a, [a, b]) < 0.001);
  // The inclusive-radius semantics themselves are tested in mask.test.ts, where the
  // comparison actually lives.
});

test('a nearby point projects onto the segment interior, not a vertex', () => {
  // The point sits off the middle of a long east-west segment.
  const dist = pointToSegmentMetres(p(37.001, -2.0), p(37.0, -2.01), p(37.0, -1.99));
  assert.ok(Math.abs(dist - 111.0) < 2.0, `expected ~111 m to the perpendicular foot, got ${dist}`);
});

test('a point beyond the segment end clamps to the vertex', () => {
  const dist = pointToSegmentMetres(p(37.0, -1.98), p(37.0, -2.01), p(37.0, -1.99));
  assert.ok(Math.abs(dist - 890.0) < 5.0, `expected ~890 m to the near vertex, got ${dist}`);
});

test('a zero-length segment is finite, not NaN', () => {
  const dist = pointToSegmentMetres(p(37.0, -2.0), p(37.0, -2.0), p(37.0, -2.0));
  assert.ok(Number.isFinite(dist));
  assert.ok(dist < 0.001);
});

test('polyline distance takes the minimum over its sub-segments', () => {
  const line = [p(37.0, -2.01), p(37.0, -2.0), p(37.0, -1.99)];
  const near = polylineDistanceMetres(p(37.0005, -2.0), line);
  assert.ok(Math.abs(near - 55.5) < 2.0, `expected ~55 m, got ${near}`);
});

test('an empty polyline is infinite rather than zero', () => {
  // Zero would mean "the fire is on it", the most alarming possible reading.
  assert.equal(polylineDistanceMetres(p(37, -2), []), Number.POSITIVE_INFINITY);
});

test('polyline length matches a hand-computed value', () => {
  // 0.01 deg of latitude at 37 N is ~1109 m; two such hops is ~2219 m.
  const len = polylineLengthMetres([p(37.0, -2.0), p(37.01, -2.0), p(37.02, -2.0)]);
  assert.ok(Math.abs(len - 2219) < 5, `expected ~2219 m, got ${len}`);
});

test('metresBetween is symmetric to within rounding', () => {
  const a = p(37.0, -2.0);
  const b = p(37.005, -2.004);
  assert.ok(Math.abs(metresBetween(a, b) - metresBetween(b, a)) < 0.5);
});

test('a closed ring needs four positions and matching ends', () => {
  const open = [p(37, -2), p(37.1, -2), p(37.1, -1.9), p(37, -1.9)];
  assert.equal(ringIsClosed(open), false);
  assert.equal(ringIsClosed([...open, open[0]]), true);
  assert.equal(ringIsClosed([p(37, -2), p(37.1, -2), p(37, -2)]), false, 'three positions is not a ring');
});

test('winding is detectable, so a reversed pair can be reconciled', () => {
  const ccw = [p(37.0, -2.0), p(37.0, -1.99), p(37.01, -1.99), p(37.01, -2.0), p(37.0, -2.0)];
  assert.ok(ringSignedAreaM2(ccw) !== 0);
  assert.ok(ringSignedAreaM2([...ccw].reverse()) !== 0);
  assert.ok(
    Math.sign(ringSignedAreaM2(ccw)) !== Math.sign(ringSignedAreaM2([...ccw].reverse())),
    'reversing a ring flips the sign of its signed area',
  );
});

test('bbox and padding', () => {
  const box = bboxOf([p(37.0, -2.0), p(37.1, -1.9)]);
  assert.deepEqual(box, [-2.0, 37.0, -1.9, 37.1]);
  assert.equal(bboxOf([]), null);
  const padded = bboxPad(box!, 1000);
  // South edge moved ~1 km south, north edge ~1 km north.
  assert.ok(Math.abs((37.0 - padded[1]) * 110977 - 1000) < 5, 'south edge pads ~1 km');
  assert.ok(Math.abs((padded[3] - 37.1) * 110977 - 1000) < 5, 'north edge pads ~1 km');
  assert.ok(padded[3] - padded[1] > box![3] - box![1]);
});

test('the reproduction distance agrees with an independent implementation', () => {
  // Cross-check against the Python reproduction that matched the spike's table.
  // Real AL-6109 geometry at Bédar and a real MTG detection from the capture.
  const detection = p(37.1922495, -1.9852262);
  const way = [
    p(37.1892912, -1.9743726),
    p(37.1923777, -1.9854314),
    p(37.1987682, -1.9963842),
  ];
  const d = polylineDistanceMetres(detection, way);
  // The Python run placed this detection well within 200 m of the road.
  assert.ok(d <= 200, `expected within 200 m of AL-6109, got ${d} m`);
});
