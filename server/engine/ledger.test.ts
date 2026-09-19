// The recommendation ledger: a durable, append-only record of what the system advised.
//
// Every test here is the verification command for one acceptance criterion of issue #26,
// and each is named so its gate pattern finds it. They drive the store directly with hand-
// built entries rather than through the engine, because the properties being pinned —
// append-only, recording order, a corrupt line surviving — are properties of the store and
// a failure in them must not be confusable with a failure in the solve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fingerprintInputs, openLedger, type AppendResult, type StoredEntry } from './ledger';

const FINGERPRINT_A = 'inputs-a';
const FINGERPRINT_B = 'inputs-b';

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ledger-')), 'recommendations.jsonl');
}

function entry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  return {
    id: 'ledger-bedar-2026-07-09T17:00:00.000Z',
    at: '2026-07-09T17:00:00.000Z',
    recordedAt: '2026-07-09T17:00:01.000Z',
    pocketId: 'bedar',
    recommendation: 'evacuate_alternate',
    evidence: ['recommended Los Gallardos', 'clearance at the tightest point: 185 min'],
    inputs: { mobileFraction: 0.7, population: 953 },
    rejected: [],
    cursorSeconds: 61200,
    inputFingerprint: FINGERPRINT_A,
    ...overrides,
  };
}

test('a cursor served before returns the entry recorded for it, not a fresh one', () => {
  // Source of expected: the entry written by this test. The point of the assertion is that
  // the returned object is the RECORDED one — a store that recomputed or reconstructed
  // would return an equal-looking entry and pass a deep-equal check, so the test also
  // writes an entry a recomputation could not produce.
  const path = storePath();
  const store = openLedger(path);
  const recorded = entry({ evidence: ['this line exists only in the store'] });
  store.append(recorded);

  const found = store.find(61200, FINGERPRINT_A, 'bedar');
  assert.ok(found, 'the entry written for this cursor and fingerprint is served back');
  assert.deepEqual(found.evidence, ['this line exists only in the store']);
  assert.equal(found.recordedAt, '2026-07-09T17:00:01.000Z');

  // A cursor never recorded is a miss, so the caller knows to compute and append.
  assert.equal(store.find(99999, FINGERPRINT_A, 'bedar'), undefined, 'an unrecorded cursor is not served');

  // The same cursor under different inputs is also a miss: the recorded recommendation
  // belongs to the inputs that produced it, and serving it for a changed capture would be
  // a stale answer presented as the recorded one.
  assert.equal(
    store.find(61200, FINGERPRINT_B, 'bedar'),
    undefined,
    'a changed input fingerprint must not reuse the entry',
  );
});

test('the record survives a restart', () => {
  const path = storePath();
  openLedger(path).append(entry());

  // A second open is what a restarted process does. Nothing is shared between the two
  // stores but the file.
  const reopened = openLedger(path);
  const found = reopened.find(61200, FINGERPRINT_A, 'bedar');
  assert.ok(found, 'the entry is still there after reopening the store');
  assert.equal(found.recommendation, 'evacuate_alternate');
  assert.deepEqual(found.evidence, ['recommended Los Gallardos', 'clearance at the tightest point: 185 min']);
});

test('entries are appended, never rewritten', () => {
  const path = storePath();
  const store = openLedger(path);
  store.append(entry({ id: 'first', cursorSeconds: 100 }));
  const afterFirst = readFileSync(path, 'utf8');

  store.append(entry({ id: 'second', cursorSeconds: 200 }));
  const afterSecond = readFileSync(path, 'utf8');

  // The first write must survive the second byte for byte. A read-modify-write
  // implementation that re-serialised the whole file would still hold both entries and
  // still pass a count assertion, so the comparison is against the exact prior content.
  assert.ok(afterSecond.startsWith(afterFirst), 'the earlier bytes are untouched by the later append');
  assert.equal(afterSecond.split('\n').filter(Boolean).length, 2, 'two lines, one per entry');
});

test('the history is one ordered sequence in recording order, not cursor order', () => {
  // A reviewer reads this to reconstruct what happened. Sorting by cursor would present a
  // later moment before an earlier one whenever the engine was asked out of order, which is
  // an incident history in an order that never happened.
  const path = storePath();
  const store = openLedger(path);
  store.append(entry({ id: 'late', cursorSeconds: 90000, at: '2026-07-10T01:00:00.000Z' }));
  store.append(entry({ id: 'early', cursorSeconds: 61200, at: '2026-07-09T17:00:00.000Z' }));

  const { entries, unreadable } = store.history();
  assert.equal(unreadable, 0);
  assert.deepEqual(entries.map((e) => e.id), ['late', 'early'], 'recording order, not sorted by cursor');
  assert.ok(
    entries[0].cursorSeconds > entries[1].cursorSeconds,
    'the fixture is discriminating: the later cursor really was recorded first',
  );
});

test('each entry names its cursor, its recording time and its evidence', () => {
  const path = storePath();
  const store = openLedger(path);
  store.append(entry());

  const [only] = store.history().entries;
  assert.equal(only.at, '2026-07-09T17:00:00.000Z', 'the cursor it applies to');
  assert.equal(only.recordedAt, '2026-07-09T17:00:01.000Z', 'the wall-clock time it was recorded');
  assert.ok(only.evidence.length > 0, 'the evidence behind it');
  assert.equal(typeof only.cursorSeconds, 'number', 'the cursor as a key, not only as a label');
  assert.equal(typeof only.inputFingerprint, 'string', 'the inputs it belongs to');
});

test('an unparsable line is skipped and counted rather than failing the whole read', () => {
  // The failure mode this guards is the opposite of the obvious one: losing the entire
  // history because one line was truncated by a crash mid-append. Skipping silently would
  // be worse still, so the count is published and asserted here.
  const path = storePath();
  const store = openLedger(path);
  store.append(entry({ id: 'good-one' }));
  appendFileSync(path, '{"id":"truncated","evide\n');
  store.append(entry({ id: 'good-two', cursorSeconds: 70000 }));

  const { entries, unreadable } = store.history();
  assert.deepEqual(entries.map((e) => e.id), ['good-one', 'good-two'], 'the readable entries all survive');
  assert.equal(unreadable, 1, 'the bad line is counted, so the reader knows the history is short');

  // And the same for a lookup: a corrupt line elsewhere must not break serving a good one.
  assert.ok(store.find(61200, FINGERPRINT_A, 'bedar'), 'a lookup still works around a corrupt line');
});

test('the same cursor under the same inputs yields the same recommendation as first recorded', () => {
  // The property is that a recorded entry and a later computation of the same cursor agree.
  // The discriminating input is the evidence string, which a recomputation would produce
  // from the solve rather than read: writing an entry whose evidence says otherwise proves
  // the comparison is against the store and not against a second computation.
  const path = storePath();
  const store = openLedger(path);
  const recorded = entry({ evidence: ['RECORDED'] });
  store.append(recorded);

  const served = store.find(recorded.cursorSeconds, recorded.inputFingerprint, recorded.pocketId);
  assert.ok(served);
  assert.notEqual(
    served.evidence[0],
    'RECOMPUTED',
    'the served entry is the stored one; a recomputation would not carry this string',
  );
  assert.deepEqual(served, recorded, 'the stored entry is returned unaltered');

  // Determinism of the fingerprint itself: the same inputs hash the same, and a changed
  // input hashes differently. Without this the key would collapse every input set into one.
  const inputs = { originIso: '2026-07-09T00:00:00.000Z', detections: 2660, profiles: ['cautious', 'optimistic'] };
  assert.equal(fingerprintInputs(inputs), fingerprintInputs({ ...inputs }));
  assert.notEqual(fingerprintInputs(inputs), fingerprintInputs({ ...inputs, detections: 2661 }));
});

test('a store whose directory cannot be created fails, naming the path', () => {
  // Falling back to an in-memory ledger would look identical until the process restarted,
  // which is the one moment the record was supposed to survive.
  assert.throws(
    () => openLedger('/dev/null/not-a-directory/recommendations.jsonl'),
    (err: unknown) => err instanceof Error && err.message.includes('/dev/null/not-a-directory'),
  );
});

test('an entry that cannot be written is reported rather than silently dropped', () => {
  const path = storePath();
  const store = openLedger(path);
  assert.deepEqual(store.append(entry({ id: 'ok' })), { ok: true }, 'a normal append reports success');

  // A store that opened correctly but can no longer be written — a full disk, a permission
  // change mid-run. The request must still serve, so the contract is that the caller learns
  // the write failed rather than the append throwing or quietly reporting success.
  chmodSync(path, 0o444);
  try {
    assert.deepEqual(
      store.append(entry({ id: 'should-fail' })),
      { ok: false, reason: 'write-failed' },
      'a failed write names its reason rather than reporting a bare failure',
    );
  } finally {
    chmodSync(path, 0o644);
  }
  assert.equal(store.history().entries.length, 1, 'the failed append left no partial entry');
});

test('a store at its cap refuses to grow, rather than deleting or growing without bound', () => {
  // The store is append-only by requirement, so nothing may be deleted or rotated. Without
  // a cap that combination leaves an unauthenticated caller free to grow the file one
  // distinct cursor at a time, and the history endpoint reads the whole thing on every call.
  // A refusal keeps the record both append-only and bounded — a history that stops, rather
  // than one that disappears.
  const path = storePath();
  const store = openLedger(path, { maxBytes: 400 });

  assert.deepEqual(store.append(entry({ id: 'fits' })), { ok: true });
  assert.equal(store.isFull(), false, 'one entry is well under the cap');

  let last: AppendResult = { ok: true };
  for (let i = 0; i < 50 && last.ok; i += 1) last = store.append(entry({ id: `more-${i}` }));
  assert.deepEqual(last, { ok: false, reason: 'full' }, 'the cap is reached and named as such');
  assert.equal(store.isFull(), true);

  const filled = store.history().entries.length;
  assert.ok(filled > 1, 'fixture sanity: the store really did fill up');

  assert.deepEqual(store.append(entry({ id: 'too-much' })), { ok: false, reason: 'full' });
  assert.equal(store.history().entries.length, filled, 'a refusal changes nothing');
  assert.equal(store.history().unreadable, 0, 'and does not corrupt what was written');
  assert.deepEqual(
    store.history().entries.map((e) => e.id)[0],
    'fits',
    'the first entry is still there: nothing was rotated out to make room',
  );
});
