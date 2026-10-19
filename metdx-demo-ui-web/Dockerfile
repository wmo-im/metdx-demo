# syntax=docker/dockerfile:1

# ---- build the static app -------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig*.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY test ./test

# Basemap is baked in at build time (see README). Defaults to OpenStreetMap.
ARG VITE_BASEMAP_URL=
ARG VITE_BASEMAP_ATTRIBUTION=
ENV VITE_BASEMAP_URL=$VITE_BASEMAP_URL \
    VITE_BASEMAP_ATTRIBUTION=$VITE_BASEMAP_ATTRIBUTION
RUN npm run build

# ---- runtime: static files + allow-listed proxy (no npm dependencies) -------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8550 \
    STATIC_DIR=/app/dist
WORKDIR /app

COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8550
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8550/healthz || exit 1
CMD ["node", "server/src/index.js"]
