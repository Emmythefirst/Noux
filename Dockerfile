# One image for both services (api and keeper); the start command differs. Build context = repo root.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @noux/api...

FROM base AS run
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY pnpm-workspace.yaml package.json ./
COPY packages/core ./packages/core
COPY packages/gateway ./packages/gateway
COPY apps/api ./apps/api
WORKDIR /app/apps/api
USER node
EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
