// The approved phrasings, selected from — never written.
//
// This is the anti-hallucination story and the first thing anyone probes. A sentence is
// chosen from a closed set per instruction and language, and every road and place name
// in it must resolve to a real OSM feature that is on the route being recommended, or
// the candidate is discarded and the rejection is shown. Nothing composes free text, so
// there is nothing to hallucinate.
//
// The sentences are deliberately plain. They will be read by someone in a hurry, on a
// phone, possibly in a second language.

import type { InstructionId, LanguageCode } from '../../../shared/alerts';

/** Placeholders a template may use. Anything else is a template bug, not a data bug. */
export const PLACEHOLDERS = ['pocket', 'road', 'destination'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export interface CapTemplate {
  instruction: InstructionId;
  /** The CAP responseType this instruction maps to. */
  responseType: 'Evacuate' | 'Prepare' | 'Execute' | 'Monitor' | 'Assess';
  /** CAP urgency. Fixed per instruction: urgency is about time to act, not about fire. */
  urgency: 'Immediate' | 'Expected' | 'Future';
  /** Body text per language, with {placeholders}. */
  text: Record<LanguageCode, string>;
  /** Whether the sentence names a road and a destination, which must then resolve. */
  namesRoad: boolean;
}

export const TEMPLATES: CapTemplate[] = [
  {
    instruction: 'evacuate_primary',
    responseType: 'Evacuate',
    urgency: 'Immediate',
    namesRoad: true,
    text: {
      es: 'Salga de {pocket} ahora por {road} hacia {destination}. No use otras vías.',
      en: 'Leave {pocket} now via {road} towards {destination}. Do not use other roads.',
      ca: 'Sortiu de {pocket} ara per {road} cap a {destination}. No utilitzeu altres vies.',
    },
  },
  {
    instruction: 'evacuate_alternate',
    responseType: 'Evacuate',
    urgency: 'Immediate',
    namesRoad: true,
    // States the fact the engine actually establishes — the route needs an unsurfaced
    // track — rather than a claim it never checks. The previous wording ("the main road
    // out of {pocket} is not safe") asserted a comparison against a main road that no
    // part of the engine identifies, and on the measured route it named the same road as
    // both the unsafe one and the one to take.
    text: {
      es: 'Salga de {pocket} por {road} hacia {destination}. La ruta incluye un camino sin asfaltar.',
      en: 'Leave {pocket} via {road} towards {destination}. The route includes an unsurfaced track.',
      ca: 'Sortiu de {pocket} per {road} cap a {destination}. La ruta inclou un camí sense asfaltar.',
    },
  },
  {
    instruction: 'no_verified_action',
    responseType: 'Prepare',
    urgency: 'Immediate',
    namesRoad: false,
    text: {
      es: 'No se ha podido verificar una ruta segura desde {pocket}. Permanezca atento a las instrucciones de los servicios de emergencia.',
      en: 'No safe route from {pocket} could be verified. Await instructions from the emergency services.',
      ca: "No s'ha pogut verificar una ruta segura des de {pocket}. Espereu instruccions dels serveis d'emergència.",
    },
  },
  {
    instruction: 'no_action',
    responseType: 'Monitor',
    urgency: 'Future',
    namesRoad: false,
    text: {
      es: 'No se requiere ninguna acción en {pocket} en este momento.',
      en: 'No action is required in {pocket} at this time.',
      ca: 'No cal cap acció a {pocket} en aquest moment.',
    },
  },
];

export function templateFor(instruction: InstructionId): CapTemplate {
  const found = TEMPLATES.find((t) => t.instruction === instruction);
  if (!found) throw new Error(`no template for instruction ${instruction}`);
  return found;
}

/**
 * Languages to broadcast in.
 *
 * Derived per settlement, never a fixed list. `ca` is a real language code in this
 * contract and is wrong for Bédar: it is in Andalucía, where the co-official language
 * argument applies to the Catalan scenario and not here. A Catalan evacuation alert for
 * an Andalusian village is the kind of detail a Spanish-speaking judge notices
 * immediately, and it costs one field to avoid.
 */
export function languagesFor(settlement: { languages?: string[] }): LanguageCode[] {
  const requested = settlement.languages ?? ['es', 'en'];
  const valid = requested.filter((l): l is LanguageCode => l === 'es' || l === 'en' || l === 'ca');
  return valid.length > 0 ? valid : ['es'];
}

export function fillTemplate(
  template: CapTemplate,
  language: LanguageCode,
  values: Partial<Record<Placeholder, string>>,
): string {
  let text = template.text[language];
  for (const key of PLACEHOLDERS) {
    const value = values[key];
    if (value === undefined) continue;
    text = text.split(`{${key}}`).join(value);
  }
  return text;
}

/** Placeholders a filled sentence still contains, which means a value was missing. */
export function unresolvedPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}
