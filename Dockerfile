# syntax=docker/dockerfile:1
#
# One image, two processes:
#   API:    node dist/server.js           (default CMD)
#   Worker: node dist/temporal/worker.js  (set as `command` in docker-compose.yml)
#
# Debian slim (glibc), not Alpine: Temporal's native core library ships glibc builds.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- build: all dependencies + TypeScript compile -------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
 && node dist/temporal/bundle-workflows.js dist/workflow-bundle.js

# ---- prod-deps: production dependencies only, from the same lockfile -------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Owned by root and read-only for the app user; the process never writes to /app.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The worker loads the workflow bundle built above instead of running webpack at startup.
ENV TEMPORAL_WORKFLOW_BUNDLE_PATH=/app/dist/workflow-bundle.js

# Unprivileged user provided by the official Node image.
USER node

EXPOSE 4000

# Exec form: node is the process that receives SIGTERM (compose adds an init via `init: true`).
CMD ["node", "dist/server.js"]
