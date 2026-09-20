# Ojo de Fuego — single-service image: Express serves both /api/* and the
# built Cesium frontend on one port. The server runs TypeScript directly via
# tsx (no server compile step), so the runtime stage keeps node_modules and
# the server/ + shared/ sources.

# --- build stage: install deps and build the frontend ---
FROM node:22-slim AS build
WORKDIR /app

# Install with the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Build the Vite/Cesium client into dist/.
COPY . .
RUN npm run build

# --- runtime stage ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bind to all interfaces inside the container (config.ts defaults to loopback).
ENV HOST=0.0.0.0
ENV PORT=3001

# Replay is the safe default: no keys, no network. Override with DATA_MODE=live
# plus Deepfire credentials as env vars in Coolify.
ENV DATA_MODE=replay

# The append-only recommendation ledger. Point this at a mounted volume in
# Coolify so the audit record survives redeploys.
ENV LEDGER_PATH=/data/ledger/recommendations.jsonl

# Copy the built app. node_modules comes from the build stage (dev deps include
# tsx, which runs the server). Committed data/ ships in the image; the ledger
# lives on a volume, not here.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/data ./data

EXPOSE 3001

# HEALTHCHECK hits the server's own /api/health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
