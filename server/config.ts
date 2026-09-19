// Shared between the Express server and the Vite proxy target so both sides
// always agree on the port.
export const SERVER_PORT = Number(process.env.PORT ?? 3001);
