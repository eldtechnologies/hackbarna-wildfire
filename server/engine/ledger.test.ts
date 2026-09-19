// The recommendation ledger: a durable, append-only record of what the system advised.
//
// Every test here is the verification command for one acceptance criterion of issue #26,
// and each is named so its gate pattern finds it. They drive the store directly with hand-
// built entries rather than through the engine, because the properties being pinned —
// append-only, recording order, a corrupt line surviving — are properties of the store and
// a failure in them must not be confusable with a failure in the solve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findEntry, fingerprintInputs, openLedger, type AppendResult, type LedgerStore, type StoredEntry } from './ledger';

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

/**
 * The store's lookup, against one read — the shape `buildAlerts` uses.
 *
 * `findEntry` is pure and takes the entries so that a request looking up several pockets reads
 * the file once instead of once per pocket. A store method here would hide that.
 */
function lookup(store: LedgerStore, cursorSeconds: number, fingerprint: string, pocketId: string) {
  return findEntry(store.history().entries, cursorSeconds, fingerprint, pocketId);
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

  const found = lookup(store, 61200, FINGERPRINT_A, 'bedar');
  assert.ok(found, 'the entry written for this cursor and fingerprint is served back');
  assert.deepEqual(found.evidence, ['this line exists only in the store']);
  assert.equal(found.recordedAt, '2026-07-09T17:00:01.000Z');

  // A cursor never recorded is a miss, so the caller knows to compute and append.
  assert.equal(lookup(store, 99999, FINGERPRINT_A, 'bedar'), undefined, 'an unrecorded cursor is not served');

  // The same cursor under different inputs is also a miss: the recorded recommendation
  // belongs to the inputs that produced it, and serving it for a changed capture would be
  // a stale answer presented as the recorded one.
  assert.equal(
    lookup(store, 61200, FINGERPRINT_B, 'bedar'),
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
  const found = lookup(reopened, 61200, FINGERPRINT_A, 'bedar');
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

test('the record reads as one ordered history, in recording order rather than cursor order', () => {
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
  assert.ok(lookup(store, 61200, FINGERPRINT_A, 'bedar'), 'a lookup still works around a corrupt line');
});

test('a line whose fields are the wrong types counts as unreadable, not as an entry', () => {
  // The read once checked the two key fields and cast the rest. These objects are served
  // verbatim by /api/ledger, so a line with `evidence` as a string was a malformed record
  // presented as a recorded one — a reader taking the type on trust would break on it.
  const path = storePath();
  const store = openLedger(path);
  store.append(entry({ id: 'good' }));
  for (const broken of [{ evidence: 'not-an-array' }, { recommendation: 42 }, { inputs: { capacity: null } }]) {
    appendFileSync(path, `${JSON.stringify({ ...entry({ id: 'bad' }), ...broken })}\n`);
  }

  const { entries, unreadable } = store.history();
  assert.deepEqual(entries.map((e) => e.id), ['good'], 'only the well-formed entry is handed back');
  assert.equal(unreadable, 3, 'each malformed line is counted, so a short history cannot read as a complete one');
});

test('an appended entry is written as it stood at the call, not as it is mutated later', () => {
  // `append` serializes the entry when it is called, so a caller that mutates the object
  // afterwards writes nothing to the record. That is right for the store — an audit line is the
  // moment it was appended, and a live view would let a later request rewrite it — and it is
  // why `buildAlerts` attaches a pocket's rejections before the append rather than in a pass
  // over the entries afterwards. That pass came after the write, so every persisted line carried
  // `rejected: []` while the log stayed intact in memory and vanished at the first restart.
  const path = storePath();
  const store = openLedger(path);
  const written = entry({ rejected: [] });
  store.append(written);
  written.rejected = [
    {
      at: '2026-07-09T17:00:00.000Z',
      pocketId: 'bedar',
      instruction: 'evacuate_alternate',
      language: 'es',
      text: 'Evacúe por la AL-6109',
      reason: 'unresolved_name',
      detail: 'the road named in the sentence has no matching way',
    },
  ];
  written.evidence.push('added after the append');

  const { entries } = store.history();
  assert.deepEqual(entries[0].rejected, [], 'the line is the entry as it stood when appended');
  assert.equal(entries[0].evidence.length, 2, 'and it is not a live view of the caller’s object');
});

test('a ledger path that is a symbolic link is refused, naming the path', () => {
  // A path resolving somewhere else makes the store's identity change with nothing saying so,
  // and an append lands in a file nobody named — including one the server's user can write but
  // the caller cannot, which turns LEDGER_PATH into a way to write through the server's
  // privileges. Refused rather than resolved: an operator who wants the ledger elsewhere points
  // the setting at it.
  const dir = mkdtempSync(join(tmpdir(), 'ledger-link-'));
  const real = join(dir, 'real.jsonl');
  const link = join(dir, 'recommendations.jsonl');
  writeFileSync(real, '');
  symlinkSync(real, link);

  assert.throws(
    () => openLedger(link),
    (err: unknown) => err instanceof Error && err.message.includes(link),
    'the refusal names the path, so an operator knows which setting to change',
  );
  assert.equal(readFileSync(real, 'utf8'), '', 'and nothing was written through the link on the way out');

  // A store on the real path works, so the refusal is about the link and not about the file.
  assert.deepEqual(openLedger(real).append(entry()), { ok: true });
});

test('the same inputs yield the same recommendation for a cursor as when it was first recorded', () => {
  // The property is that a recorded entry and a later computation of the same cursor agree.
  // The discriminating input is the evidence string, which a recomputation would produce
  // from the solve rather than read: writing an entry whose evidence says otherwise proves
  // the comparison is against the store and not against a second computation.
  const path = storePath();
  const store = openLedger(path);
  const recorded = entry({ evidence: ['RECORDED'] });
  store.append(recorded);

  const served = lookup(store, recorded.cursorSeconds, recorded.inputFingerprint, recorded.pocketId);
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

test('a change to a nested input value moves the fingerprint, not only a top-level one', () => {
  // The digest once passed its keys as a replacer ARRAY, which JSON.stringify applies at every
  // level of the object graph. A nested object therefore kept only the keys that were also
  // top-level names, and the call site's `profiles.map((p) => [p.id, p.assumptions])` reached
  // the hash as `[["cautious",{}]]` — the assumption values are the axis this key exists to
  // cover, and it was blind to them. The old test used a flat `profiles: ['cautious', ...]`,
  // which is why it passed throughout. The discriminating input here is nested, and the two
  // levels are separate cases because a replacer array drops them independently.
  const base = {
    origin: '2026-07-09T17:00:00.000Z',
    detections: 2743,
    profiles: [['cautious', { capacityPerHour: 600, speedByHighway: { track: 20 } }]],
    pockets: [['bedar', 953]],
  };
  const shallower = { ...base, profiles: [['cautious', { capacityPerHour: 180, speedByHighway: { track: 20 } }]] };
  const deeper = { ...base, profiles: [['cautious', { capacityPerHour: 600, speedByHighway: { track: 40 } }]] };

  assert.notEqual(fingerprintInputs(base), fingerprintInputs(shallower), 'a value two levels down');
  assert.notEqual(fingerprintInputs(base), fingerprintInputs(deeper), 'and a value three levels down');

  // Stability is what the key sort was for, and it survives the recursion: the same inputs
  // built in a different order still agree.
  assert.equal(
    fingerprintInputs(base),
    fingerprintInputs({ pockets: base.pockets, profiles: base.profiles, detections: 2743, origin: base.origin }),
  );
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
