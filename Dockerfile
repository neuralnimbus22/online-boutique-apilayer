# syntax=docker/dockerfile:1
# Slim, single-stage build for the apilayer service.
# Multi-stage isn't worth it here — the only devDep is supertest, and
# `npm ci --omit=dev` skips it, so a single stage already produces a
# minimal image. Alpine keeps the base small (pg + ioredis are pure JS,
# no native deps that would force us off musl libc).

FROM node:20-alpine

WORKDIR /app

# Install production deps from the lockfile only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app source + schema. .dockerignore keeps node_modules / tests out.
COPY src ./src
COPY db ./db

EXPOSE 3000

# Run as the unprivileged 'node' user that ships in the node:alpine image.
USER node

CMD ["node", "src/server.js"]
