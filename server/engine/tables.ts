// Table lookups that cannot reach the prototype chain.
//
// `TABLE[key] ?? fallback` is the obvious spelling and it is wrong whenever `key` comes from data
// rather than from a closed set of literals. For `key = 'constructor'` the lookup returns the
// `Object` function; for `'__proto__'` it returns `Object.prototype`. Both are truthy, so the `??`
// fallback never fires and the value flows onward — as a rate, a radius, a latency or a road class.
//
// Found by review in four tables, each with a different consequence, which is why this is one
// function and not four guards:
//
//   * `SENSOR_FAMILY` — a family that was not a string, reaching the wire as `{"family":{}}`.
//   * `SENSOR_FOOTPRINT_M` — `Object * scale` is NaN, and every `distanceM > NaN` is false, so the
//     detection was treated as reaching every road segment in the graph.
//   * `LATENCY_SECONDS` — the NaN went into a `Float64Array` and every `cut + NaN <= cursor` was
//     false, so the engine stopped marking roads cut and published `not_yet_observed` where the
//     same capture with an unknown source publishes `no_verified_action`. The permissive direction.
//   * the speed and capacity tables — a `RangeError` out of `withAssumedSpeeds`, which fails every
//     engine route closed.
//
// The keys are data: a detection's `source` comes from the capture, an edge's `highway` from the
// road graph. A closed set of literals would not need this.

/**
 * `table[key]`, or `undefined` when the key is not an own property of the table.
 *
 * Own, not inherited. `Object.hasOwn` is what makes this safe for a key that names a member of
 * `Object.prototype` — `'__proto__'` is an accessor there, never an own property of the table, so
 * this returns `undefined` and the caller's fallback fires as it was meant to.
 */
export function ownLookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
