// Shared between the Express server and the Vite proxy target so both sides
// always agree on the port.
export const SERVER_PORT = Number(process.env.PORT ?? 3001);

// Loopback by default: /api/fires is an authenticated, metered proxy, and any
// peer that can reach the port can spend the Deepfire quota. Set HOST=0.0.0.0 to
// expose it on the LAN, for example to show the demo from a phone.
export const SERVER_HOST = process.env.HOST ?? '127.0.0.1';
