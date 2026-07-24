FROM docker.io/library/node:20-alpine AS builder

ARG PNPM_VERSION=9.15.9
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build && pnpm prune --prod

FROM docker.io/library/node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Without this, Render's Docker health checker falls back to a "usually" reliable auto-detected
# port instead of a guaranteed one -- see deploy/render/render.yaml's HTTP_PORT/PORT comment for
# the deploy-timeout incident this caused. Must match HTTP_PORT/PORT there.
EXPOSE 10000

USER node
ENTRYPOINT ["node", "dist/index.js"]
