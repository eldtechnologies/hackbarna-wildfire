// Shared between the Express server and the Vite proxy target so both sides
// always agree on the port.
export const SERVER_PORT = Number(process.env.PORT ?? 3001);

// Loopback by default: /api/fires is an authenticated, metered proxy, and any
// peer that can reach the port can spend the Deepfire quota. Set HOST=0.0.0.0 to
// expose it on the LAN, for example to show the demo from a phone.
export const SERVER_HOST = process.env.HOST ?? '127.0.0.1';

/**
 * Where the recommendation ledger is appended.
 *
 * Runtime state rather than a committed fixture: it is a record of what THIS deployment
 * advised, so it is gitignored and lives under `data/ledger/`. Configurable because a real
 * deployment wants it on a volume that outlives the container, and because a test wants it
 * in a temporary directory rather than in the working tree.
 */
export const LEDGER_PATH = process.env.LEDGER_PATH ?? 'data/ledger/recommendations.jsonl';
