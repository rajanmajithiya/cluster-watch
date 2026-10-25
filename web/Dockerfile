# syntax=docker/dockerfile:1

# ---- Stage 1: build the Angular app (needs Node, the compiler, ~200 MB of node_modules) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build

# ---- Stage 2: serve the result. No Node, no node_modules, no TypeScript: just static files + nginx ----
# The "unprivileged" variant runs as uid 101 on port 8080 (the official nginx image starts as root on 80).
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/web/browser /usr/share/nginx/html
# Default for docker compose; Kubernetes overrides it (http://api:80).
ENV API_UPSTREAM=http://api:3000
EXPOSE 8080
