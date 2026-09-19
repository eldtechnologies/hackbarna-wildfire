// XML escaping for CAP emission.
//
// Hand-rolled rather than a dependency: the document is twenty elements with no
// namespaces to manage, the schema is the specification, and there is a validator
// (`xmllint --schema`, used in the tests) to act as the compiler. A library here would
// buy nothing and cost the zero-dependency property the engine otherwise keeps.
//
// Pocket and road names come from OpenStreetMap and Catastro, so they are third-party
// text reaching an XML document. `Bédar & Sons <Norte>` is a real shape of OSM name.

/**
 * Escape text for XML character data.
 *
 * `&` must go first, or the escapes produced for the other characters are themselves
 * escaped and the name arrives mangled.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Remove characters XML 1.0 forbids outright, and which no escaping can rescue: C0
 * controls other than tab, newline and carriage return, plus the C1 range.
 *
 * Escaping does not help here — these are invalid at the character level, so a document
 * containing them is not well-formed however it is written.
 */
export function stripForbiddenChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

/** The full treatment for any third-party string entering the document. */
export function clean(value: string): string {
  return escapeXml(stripForbiddenChars(value));
}

/**
 * Format a coordinate ring as a CAP `<polygon>`.
 *
 * CAP wants `lat,lon` pairs, space separated, WGS84 — the opposite order from GeoJSON,
 * and a swap is invisible to the schema: `<polygon>` is typed `xs:string` with no
 * pattern, so a lon/lat ring validates perfectly while describing a point in the Indian
 * Ocean. That is why the tests assert on coordinate ranges rather than on schema
 * validity alone.
 */
export function formatPolygon(ring: Array<{ lat: number; lon: number }>): string {
  const parts: string[] = [];
  for (const p of ring) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180) continue;
    parts.push(`${p.lat.toFixed(6)},${p.lon.toFixed(6)}`);
  }
  return parts.join(' ');
}
