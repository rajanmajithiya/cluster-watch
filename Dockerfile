# syntax=docker/dockerfile:1

# ---- Stage 1: install production dependencies only ----
# alpine (~50 MB) instead of the full Debian node image (~1 GB). In production, also pin the digest
# (node:24-alpine@sha256:...) so a rebuild next month can't silently pull a different base.
FROM node:24-alpine AS deps
WORKDIR /app
# Copy ONLY the manifests first. Docker caches each layer, so as long as package*.json don't change,
# the slow `npm ci` below is skipped on rebuild, even when src/ changed.
COPY package.json package-lock.json ./
# npm ci: exact versions from the lockfile, fails if it's out of sync (reproducible builds).
# --omit=dev: no nodemon, no embedded-postgres in the production image.
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 2: the runtime image ----
# Starts clean: nothing from stage 1 comes along except what we explicitly COPY --from.
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node src ./src

# Never run as root. If an attacker gets code execution in the app, they're an unprivileged user,
# not root inside the container (one step closer to the host).
USER node

EXPOSE 3000 3001

# Exec form (JSON array): node runs as PID 1 and receives SIGTERM directly.
# Shell form (`CMD node src/server.js`) wraps it in /bin/sh, which does NOT forward signals,
# so `docker stop` waits 10 s and then SIGKILLs: no graceful shutdown.
# The same image runs the worker by overriding the command: ["node", "src/worker.js"].
CMD ["node", "src/server.js"]
