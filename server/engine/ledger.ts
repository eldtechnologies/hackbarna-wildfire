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
//
// TRUST BOUNDARY: the file's contents are trusted. Whoever can write the ledger directory can
// append a well-formed line that no reader here can tell from a recorded one, and this store
// does not pretend otherwise. Shape is checked on read — a line whose fields are the wrong types
// is counted unreadable — but provenance is not, and making a forged line detectable needs a
// chain or a signature over the lines, which a record of the engine's own advisories does not
// call for. The path itself is held to a stricter standard than its contents: see `openLedger`.

import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';

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
 * of a history that stops rather than one that disappears.
 *
 * What the cap holds in practice: entries measured 703 to 1,251 bytes across the capture's
 * cursors, so this is roughly thirteen to twenty-four thousand recommendations — far more than
 * a replay reaches. An earlier version of this comment said "roughly 800 bytes, about twenty
 * thousand", which is inside that range but reads as a measurement rather than the estimate it
 * was.
 */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface LedgerStore {
  /** Append one entry. Reports rather than throws, so a request can still serve. */
  append(entry: StoredEntry): AppendResult;
  /** Whether the store has reached its cap and will accept no more. */
  isFull(): boolean;
  /** Everything, in recording order, with the number of lines that could not be read. */
  history(): { entries: StoredEntry[]; unreadable: number };
}

/**
 * The entry recorded for this pocket, at this cursor, under these inputs.
 *
 * All three are part of the identity: several pockets are recorded at one cursor, so a lookup on
 * cursor and inputs alone would return whichever happened to be written first and serve one
 * village's recommendation for another. Last match wins, because entries are append-only: if the
 * same key was somehow written twice, the later one records what was last advised.
 *
 * Pure, and taking the entries rather than reading them, because the caller looks up one pocket
 * per settlement in a request — doing that against the store meant re-reading and re-parsing the
 * whole file once per village, on every cache miss.
 */
export function findEntry(
  entries: readonly StoredEntry[],
  cursorSeconds: number,
  fingerprint: string,
  pocketId: string,
): StoredEntry | undefined {
  let found: StoredEntry | undefined;
  for (const candidate of entries) {
    if (
      candidate.cursorSeconds === cursorSeconds &&
      candidate.inputFingerprint === fingerprint &&
      candidate.pocketId === pocketId
    ) {
      found = candidate;
    }
  }
  return found;
}

/**
 * A short, stable digest of the inputs a recommendation was computed from.
 *
 * Deliberately over the things that change the answer rather than over the whole response,
 * which carries the answer itself and would make every fingerprint unique. Callers pass the
 * same shape every time; the keys are sorted so two calls with the same inputs in a different
 * construction order agree.
 *
 * The sort has to reach every level, and that is the whole point rather than a detail. The
 * obvious spelling — `JSON.stringify(inputs, Object.keys(inputs).sort())` — passes the keys as
 * a replacer ARRAY, which is a property allow-list applied at every level of the object graph.
 * A nested object therefore keeps only the keys that also happen to be top-level names, and one
 * sharing no names serializes to `{}`: the call site passes
 * `profiles.map((p) => [p.id, p.assumptions])`, and `assumptions` reached the digest as
 * `[["cautious",{}]]`. The assumption values are the axis this key exists to cover, so the
 * digest was blind to precisely what it was for, and a store written under one assumption set
 * answered for another with nothing in the record saying so.
 *
 * Scope: plain JSON data. A `Date`, `Map` or `Set` would digest as `{}` where `JSON.stringify`
 * would call `toJSON`; the call site passes strings, numbers, arrays and plain objects, and the
 * one date in the set is already an ISO string.
 */
export function fingerprintInputs(inputs: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(inputs)).digest('hex').slice(0, 16);
}

/** JSON with every object's keys sorted, at every depth. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${(value as unknown[]).map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    // Matches `JSON.stringify`, which omits a key whose value is undefined rather than
    // emitting a bare one. A hole in an array is a different case and stringifies to null.
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * The store's name without its directory.
 *
 * `/api/ledger` and the alert diagnostics are reachable without credentials, and the configured
 * path is exactly the absolute one an operator sets to put the ledger on a durable volume — so
 * publishing it hands an anonymous caller the deployment's directory layout. The basename still
 * answers what the field is there for ("which store produced this") and stops there.
 */
export const ledgerName = (path: string): string => basename(path);

/** `O_NOFOLLOW` on both the read and the append, so neither follows a symbolic link. */
const { O_APPEND, O_CREAT, O_NOFOLLOW, O_RDONLY, O_WRONLY } = constants;

/**
 * Whether a parsed line is a stored entry.
 *
 * The store's job is to hand back `StoredEntry`, and a cast does not make one. Type is what a
 * reader of the history relies on — `/api/ledger` serves these objects verbatim — so a line whose
 * `evidence` is a string rather than an array is a malformed record, not a record with a quirk.
 * Checked field by field for that reason, having once accepted anything carrying the two key
 * fields.
 *
 * This is a shape check and not a provenance one; see the trust boundary at the top of the file.
 */
function isStoredEntry(value: unknown): value is StoredEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.cursorSeconds !== 'number' || typeof c.inputFingerprint !== 'string') return false;
  for (const field of ['id', 'at', 'recordedAt', 'pocketId', 'recommendation'] as const) {
    if (typeof c[field] !== 'string') return false;
  }
  if (!Array.isArray(c.evidence) || !c.evidence.every((line) => typeof line === 'string')) return false;
  if (c.inputs === null || typeof c.inputs !== 'object' || Array.isArray(c.inputs)) return false;
  if (!Object.values(c.inputs as Record<string, unknown>).every((v) => typeof v === 'string' || typeof v === 'number')) {
    return false;
  }
  return Array.isArray(c.rejected);
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
   * Refuse a ledger path that is a symbolic link.
   *
   * The store's identity is "this file is the record". A path that resolves somewhere else makes
   * that identity change with nothing saying so, and an append lands in a file the operator never
   * named — including one the server's user can write but the caller cannot, which turns the
   * ledger path into a way to write through the server's privileges. Refused rather than resolved,
   * in the posture of everything above: an operator who wants the ledger on a durable volume sets
   * `LEDGER_PATH` to that volume, which is what the setting is for.
   *
   * The final component only. A symlinked ancestor directory is not covered — on macOS `/tmp` is
   * one, so covering them would refuse every store opened under a temporary directory, which is
   * where every test opens one. `O_NOFOLLOW` on the read and the append holds the same line at the
   * syscall, so a link swapped in after this check fails the operation instead of being followed.
   */
  const refuseSymlink = (): void => {
    let stats;
    try {
      stats = lstatSync(path);
    } catch (err) {
      // No file yet is an empty ledger, not a failure — the first append creates it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`the ledger path ${path} is a symbolic link; set LEDGER_PATH to the real file`);
    }
  };
  refuseSymlink();

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
      // Opened in two steps rather than `readFileSync(path, { flag })`, because that option is
      // typed as a string and `O_NOFOLLOW` has no string spelling — the platform takes the
      // number, and `openSync` is the one typed to accept it.
      const fd = openSync(path, O_RDONLY | O_NOFOLLOW);
      try {
        raw = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
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
      if (!isStoredEntry(parsed)) {
        // A well-formed JSON object that is not a ledger entry: a schema from an earlier
        // version, a line someone edited by hand, or something else entirely. Counted rather
        // than crashing the read, and not cast through — see `isStoredEntry`.
        unreadable += 1;
        continue;
      }
      entries.push(parsed);
    }
    return { entries, unreadable };
  };

  return {
    isFull() {
      try {
        // `lstat`, matching the read and the append: this store does not follow links, so
        // the size it reasons about must be the size of the file it will actually open.
        return lstatSync(path).size >= limits.maxBytes;
      } catch (err) {
        // No file yet is an empty store, which is not full.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    },

    append(entry) {
      // Checked before the write rather than after, so the cap is a bound and not a
      // post-mortem. `lstat` is O(1) where counting entries would mean reading the file.
      let size = 0;
      try {
        size = lstatSync(path).size;
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
        const line = `${JSON.stringify(entry)}\n`;
        const fd = openSync(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW);
        try {
          const written = writeSync(fd, line);
          // A short write leaves a truncated line, which is the exact corruption the read path
          // counts as unreadable — so it is a failed append, not a partial success.
          if (written !== Buffer.byteLength(line)) {
            throw new Error(`short write: ${written} of ${Buffer.byteLength(line)} bytes`);
          }
        } finally {
          closeSync(fd);
        }
        return { ok: true };
      } catch (err) {
        // The request must still serve, so this reports rather than throws; the caller puts
        // the failure where a reader can see it instead of dropping the entry in silence.
        // A link swapped in after `openLedger` lands here as ELOOP rather than writing into
        // a file nobody named.
        console.error(`[ledger] could not append an entry to ${path}:`, err);
        return { ok: false, reason: 'write-failed' };
      }
    },

    history() {
      return read();
    },
  };
}
