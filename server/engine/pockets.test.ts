import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latLonToUtm30n, utm30nToLatLon, loadPocketGeometry } from './pockets';

test('the projection round-trips to a few centimetres', () => {
  // The fixture keeps EPSG:25830 and the engine converts on load, so an error here is an
  // error in every pocket outline and every CAP polygon drawn from one.
  //
  // Measured: 4-6 cm across the working area, and 6 cm as far away as Madrid. That is
  // the truncation of the standard series, not a defect — a building footprint is ten
  // metres across and a CAP polygon is kilometres, so this is three orders of magnitude
  // below anything it is used for. The bound is set just above the measured value so a
  // regression that doubles it fails, without being so tight that the series itself
  // trips it.
  const points: Array<[number, number]> = [
    [37.1909, -1.9806], // Bédar
    [37.1725, -1.9386], // Los Gallardos
    [37.2439, -2.0421], // Lubrín
    [37.1398, -1.851],  // Mojácar
    [40.4168, -3.7038], // Madrid, far outside the working area
    [36.0, -6.0],       // far south-west
  ];
  for (const [lat, lon] of points) {
    const { e, n } = latLonToUtm30n(lat, lon);
    const back = utm30nToLatLon(e, n);
    const dLat = Math.abs(back.lat - lat) * 110977;
    const dLon = Math.abs(back.lon - lon) * 88970;
    const err = Math.hypot(dLat, dLon);
    assert.ok(err < 0.25, `${lat},${lon} round-tripped ${err.toFixed(4)} m out`);
  }
});

test('the projection agrees with a published reference point', () => {
  // Madrid city centre in ETRS89 / UTM 30N is about E 440 000, N 4 474 000. An earlier
  // version of this used 3 degrees EAST as the central meridian, which put Bédar 533 km
  // from where it is and silently returned an empty Catastro response.
  const { e, n } = latLonToUtm30n(40.4168, -3.7038);
  assert.ok(e > 435000 && e < 445000, `easting ${e} is not Madrid`);
  assert.ok(n > 4470000 && n < 4480000, `northing ${n} is not Madrid`);
});

test('Bédar lands where the Catastro query found it', () => {
  // The coordinates the verified footprint fetch used, recorded so a change to the
  // projection is visible as a test failure rather than as an empty pocket.
  const { e, n } = latLonToUtm30n(37.1909576, -1.9806488);
  assert.ok(Math.abs(e - 590471.8) < 2, `easting ${e.toFixed(1)}`);
  assert.ok(Math.abs(n - 4116542.8) < 2, `northing ${n.toFixed(1)}`);
});

test('a missing fixture yields no geometry rather than throwing', () => {
  // The engine runs before the footprints land; an exception here would take down every
  // route rather than degrade one outline.
  const geometry = loadPocketGeometry('/nonexistent/buildings.json');
  assert.equal(geometry.size, 0);
});
