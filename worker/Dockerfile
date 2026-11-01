# Derived from NearDeFi/shade-agent-template (Apache-2.0). Modified: pnpm instead of npm, worker build.
# The image digest of this build ends up in the TEE measurements (app-compose hash), so keep inputs pinned.
ARG SOURCE_DATE_EPOCH=0

FROM node:22-alpine@sha256:92d51e5f20b7ff58faa5a969af1a1cec6cbec3fbff7e0f523242b9b5c85ad887 AS base
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS builder
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json tee.config.json ./
# audit L10: do not run as root
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
