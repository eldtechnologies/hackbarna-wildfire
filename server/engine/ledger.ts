// The recommendation ledger: a durable, append-only record of what the engine advised.
//
// The response already carried a well-formed ledger, and it was recomputed from scratch on
// every request. That makes a single cursor auditable and an incident unreadable: two
// cursors produced two independent sets that were never joined, and a restart lost both. A
// reviewer could reconstruct any moment they already knew to ask for and nothing else.
//
// Three properties are load-bearing and each is pinned by a test:
//
//   * APPEND ONLY. The file is opened for append and never rewritten. An audit record that
//     a later request can alter is not an audit record, and nothing here has a deletion path.
//   * RECORDING ORDER. The history is read in the order entries were written, not sorted by
//     cursor. The engine is asked for cursors by a scrubber, not in sequence, so sorting
//     would present a later moment before an earlier one — an incident history in an order
//     that never happened.
//   * KEYED BY INPUTS AS WELL AS TIME. A cursor names an instant, but the instant means
//     something different under a different capture or different assumption values. Keying
//     by cursor alone would serve a recommendation the current inputs do not support, with
//     nothing in the record saying so.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { LedgerEntry } from '../../shared/alerts';

/**
 * A recorded recommendation, plus what it is a record *of*.
 *
 * The two extra fields are what make the store answerable: `cursorSeconds` is the key's
 * first half in the unit the engine counts in, and `inputFingerprint` is the second.
 */
export interface StoredEntry extends LedgerEntry {
  /** Seconds since the scenario origin. */
  cursorSeconds: number;
  /** Which input set this entry belongs to. See `fingerprintInputs`. */
  inputFingerprint: string;
}

/**
 * Why an append did not happen.
 *
 * Distinguished because the two mean different things to a reader: a write failure is a
 * fault that should be investigated, while a full store is the record working as designed
 * and saying so.
 */
export type AppendResult = { ok: true } | { ok: false; reason: 'write-failed' | 'full' };

export interface LedgerLimits {
  /** Refuse to append once the file has reached this many bytes. */
  maxBytes: number;
}

/**
 * The default cap, 16 MiB.
 *
 * The store is append-only by requirement, so nothing here deletes or rotates — which means
 * without a cap an unauthenticated caller reaching the port could grow the file without
 * bound, one distinct cursor at a time, and `/api/ledger` reads the whole thing on every
 * call. Refusing to grow past a limit keeps the record append-only AND bounded, at the cost
 * of a history that stops rather than one that disappears. At roughly 800 bytes an entry
 * this is about twenty thousand recommendations, which is far more than a replay holds.
 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface LedgerStore {
  /**
   * The entry recorded for this pocket, at this cursor, under these inputs.
   *
   * All three are part of the identity: several pockets are recorded at one cursor, so a
   * lookup on cursor and inputs alone would return whichever happened to be written first
   * and serve one village's recommendation for another.
   */
  find(cursorSeconds: number, fingerprint: string, pocketId: string): StoredEntry | undefined;
  /** Append one entry. Reports rather than throws, so a request can still serve. */
  append(entry: StoredEntry): AppendResult;
  /** Whether the store has reached its cap and will accept no more. */
  isFull(): boolean;
  /** Everything, in recording order, with the number of lines that could not be read. */
  history(): { entries: StoredEntry[]; unreadable: number };
}

/**
 * A short, stable digest of the inputs a recommendation was computed from.
 *
 * Deliberately over the things that change the answer rather than over the whole response,
 * which carries the answer itself and would make every fingerprint unique. Callers pass the
 * same shape every time; `fingerprintInputs` sorts the keys so two calls with the same
 * inputs in a different construction order agree.
 */
export function fingerprintInputs(inputs: Record<string, unknown>): string {
  const stable = JSON.stringify(inputs, Object.keys(inputs).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * Open the store at `path`, creating its directory if it is missing.
 *
 * Refuses rather than degrading. A store that could not be opened and fell back to an
 * in-memory ledger would look identical until the process restarted — which is the one
 * moment the record was supposed to survive — so an unusable path is an error at startup
 * that names the path, and the caller decides what to do about it.
 */
export function openLedger(path: string, limits: LedgerLimits = { maxBytes: DEFAULT_MAX_BYTES }): LedgerStore {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    throw new Error(
      `cannot create the ledger directory for ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  /**
   * Read every readable entry, counting the ones that are not.
   *
   * A truncated final line is what a crash mid-append leaves behind, and it is the most
   * likely corruption there is. Throwing on it would lose the whole history to one bad
   * byte; skipping it silently would let a reader mistake a short history for a complete
   * one. So the good entries come back and the count comes with them.
   */
  const read = (): { entries: StoredEntry[]; unreadable: number } => {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      // No file yet is an empty ledger, not a failure — the first append creates it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], unreadable: 0 };
      throw err;
    }
    const entries: StoredEntry[] = [];
    let unreadable = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        unreadable += 1;
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unreadable += 1;
        continue;
      }
      const candidate = parsed as Partial<StoredEntry>;
      if (typeof candidate.cursorSeconds !== 'number' || typeof candidate.inputFingerprint !== 'string') {
        // A well-formed JSON object that is not a ledger entry: a schema from an earlier
        // version, or something else entirely. Counted rather than crashing the read.
        unreadable += 1;
        continue;
      }
      entries.push(candidate as StoredEntry);
    }
    return { entries, unreadable };
  };

  return {
    find(cursorSeconds, fingerprint, pocketId) {
      // Last match wins: entries are append-only, so if the same key was somehow written
      // twice the later one is the record of what was last advised.
      let found: StoredEntry | undefined;
      for (const candidate of read().entries) {
        if (
          candidate.cursorSeconds === cursorSeconds &&
          candidate.inputFingerprint === fingerprint &&
          candidate.pocketId === pocketId
        ) {
          found = candidate;
        }
      }
      return found;
    },

    isFull() {
      try {
        return statSync(path).size >= limits.maxBytes;
      } catch (err) {
        // No file yet is an empty store, which is not full.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },

    append(entry) {
      // Checked before the write rather than after, so the cap is a bound and not a
      // post-mortem. `stat` is O(1) where counting entries would mean reading the file.
      let size = 0;
      try {
        size = statSync(path).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (size >= limits.maxBytes) {
        console.error(
          `[ledger] refusing to append to ${path}: the store has reached its ${limits.maxBytes}-byte cap`,
        );
        return { ok: false, reason: 'full' };
      }
      try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { flag: 'a' });
        return { ok: true };
      } catch (err) {
        // The request must still serve, so this reports rather than throws; the caller puts
        // the failure where a reader can see it instead of dropping the entry in silence.
        console.error(`[ledger] could not append an entry to ${path}:`, err);
        return { ok: false, reason: 'write-failed' };
      }
    },

    history() {
      return read();
    },
  };
}
