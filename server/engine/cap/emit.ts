// CAP 1.2 emission.
//
// Element order is enforced by the schema's xs:sequence and is the thing a first attempt
// gets wrong. The order inside <info> in particular is not the order the fields are
// usually discussed in:
//
//   language, category, event, responseType, urgency, severity, certainty, audience,
//   eventCode, effective, onset, expires, senderName, headline, description,
//   instruction, web, contact, parameter, resource, area
//
// and inside <area>: areaDesc, polygon, circle, geocode, altitude, ceiling.
//
// Timestamps go through formatCapTimestamp, never toISOString: the schema restricts them
// to \d\d\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[-,+]\d\d:\d\d, so a trailing Z and fractional
// seconds are both rejected. Verified with xmllint against the official XSD.

import type { AlertPackage, CapSenderConfig } from '../../../shared/alerts';
import type { LatLon } from '../../../shared/fires';
import { clean, formatPolygon } from './xml';

export interface CapAlertInput {
  identifier: string;
  sender: CapSenderConfig;
  /** Instant the message is issued — the cursor, never the wall clock. */
  sentMs: number;
  /** Free text describing what produced this, e.g. the scenario id. */
  source: string;
  /** One package per language, all for the same pocket. */
  packages: AlertPackage[];
  /** Pocket outline, closed ring. */
  area: LatLon[];
  eventName: string;
  /** How long the message stays valid, seconds after `sent`. Defaults to 6 hours. */
  validForSeconds?: number;
  timeZone?: string;
}

import { formatCapTimestamp } from '../time';
import { templateFor } from './templates';

/** One <alert> per pocket, one <info> per language — the plan's decision 10. */
export function groupByPocket(packages: AlertPackage[]): Map<string, AlertPackage[]> {
  const out = new Map<string, AlertPackage[]>();
  for (const pkg of packages) {
    const list = out.get(pkg.pocketId);
    if (list) list.push(pkg);
    else out.set(pkg.pocketId, [pkg]);
  }
  return out;
}

/**
 * Emit one CAP 1.2 document.
 *
 * Returns a complete, standalone document. A multi-pocket send is several documents,
 * because CAP has a single <alert> root — each alert is its own message with its own
 * identifier, which is also how a real system tracks acknowledgements.
 */
export function emitCap(input: CapAlertInput): string {
  const tz = input.timeZone;
  const { sender } = input;
  const sent = formatCapTimestamp(input.sentMs, tz);
  const expires = formatCapTimestamp(input.sentMs + (input.validForSeconds ?? 6 * 3600) * 1000, tz);

  const infos = input.packages
    .slice()
    .sort((a, b) => a.language.localeCompare(b.language))
    .map((pkg) => {
      const template = templateFor(pkg.instruction);
      return [
        '  <info>',
        `    <language>${clean(pkg.language)}</language>`,
        '    <category>Fire</category>',
        '    <category>Safety</category>',
        `    <event>${clean(input.eventName)}</event>`,
        `    <responseType>${template.responseType}</responseType>`,
        `    <urgency>${pkg.urgency}</urgency>`,
        `    <severity>${pkg.severity}</severity>`,
        `    <certainty>${pkg.certainty}</certainty>`,
        '    <eventCode>',
        '      <valueName>deepfire:cluster_id</valueName>',
        `      <value>${clean(pkg.pocketId)}</value>`,
        '    </eventCode>',
        `    <effective>${sent}</effective>`,
        `    <onset>${sent}</onset>`,
        `    <expires>${expires}</expires>`,
        `    <senderName>${clean(sender.senderName)}</senderName>`,
        `    <headline>${clean(headlineFor(pkg))}</headline>`,
        `    <description>${clean(pkg.text)}</description>`,
        `    <instruction>${clean(pkg.text)}</instruction>`,
        '    <area>',
        `      <areaDesc>${clean(pkg.pocketName)}</areaDesc>`,
        `      <polygon>${formatPolygon(input.area)}</polygon>`,
        '    </area>',
        '  </info>',
      ].join('\n');
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">',
    `  <identifier>${clean(input.identifier)}</identifier>`,
    `  <sender>${clean(sender.sender)}</sender>`,
    `  <sent>${sent}</sent>`,
    `  <status>${sender.status}</status>`,
    '  <msgType>Alert</msgType>',
    `  <source>${clean(input.source)}</source>`,
    `  <scope>${sender.scope}</scope>`,
    ...infos,
    '</alert>',
    '',
  ].join('\n');
}

/** Short line for the notification, kept under the length a lock screen shows. */
function headlineFor(pkg: AlertPackage): string {
  const cut = pkg.text.length > 90 ? `${pkg.text.slice(0, 87)}...` : pkg.text;
  return cut;
}

/**
 * Structural checks the XSD cannot make.
 *
 * The schema types <polygon> as xs:string with no pattern, so a garbage string and a
 * lon/lat-swapped ring both validate perfectly while describing somewhere that is not
 * Bédar. Schema validity is necessary and not sufficient, and these are the missing half.
 */
export interface CapValidation {
  ok: boolean;
  problems: string[];
}

export function validateCapSemantics(input: CapAlertInput, xml: string): CapValidation {
  const problems: string[] = [];

  const ring = input.area;
  if (ring.length < 4) problems.push(`polygon ring has ${ring.length} positions; a closed ring needs at least 4`);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first.lat !== last.lat || first.lon !== last.lon)) {
    problems.push('polygon ring is not closed');
  }
  // The swap the schema cannot catch. These bounds are the Iberian peninsula, so a
  // lon/lat ring at Bédar fails immediately while the document still validates.
  for (const p of ring) {
    if (!(p.lat > 35 && p.lat < 44)) problems.push(`polygon latitude ${p.lat} is outside Iberia — lon/lat swapped?`);
    if (!(p.lon > -10 && p.lon < 4)) problems.push(`polygon longitude ${p.lon} is outside Iberia — lon/lat swapped?`);
  }

  // Anything that survives escaping as a raw angle bracket means the escaper was bypassed.
  if (/<[a-zA-Z/]/.test(xml.replace(/<[^>]*>/g, ''))) problems.push('document contains unescaped markup outside tags');

  const infos = (xml.match(/<info>/g) ?? []).length;
  if (infos !== input.packages.length) {
    problems.push(`${infos} <info> blocks for ${input.packages.length} language packages`);
  }
  if (infos === 0) problems.push('a CAP document needs at least one <info>; the XSD permits zero, the spec does not');

  // Private and Restricted both require <addresses> under the prose spec, which the XSD
  // does not enforce. Checked here so a profile that chooses one cannot ship without it.
  if ((input.sender.scope === 'Private' || input.sender.scope === 'Restricted') && !/<addresses>/.test(xml)) {
    problems.push(`scope=${input.sender.scope} requires an <addresses> element`);
  }

  return { ok: problems.length === 0, problems };
}

/** Deterministic identifier, so a replay is reproducible and a ledger can match runs. */
export function capIdentifier(pocketId: string, atIso: string, instruction: string): string {
  const stamp = atIso.replace(/[-:]/g, '').replace(/\.\d+Z?$/, 'Z');
  return `ojo-de-fuego:${pocketId}:${stamp}:${instruction}`;
}
