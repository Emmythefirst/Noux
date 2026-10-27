# One image for every service (api, demo-merchant); the start command differs. Build context = repo root.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/gateway/package.json packages/gateway/
COPY apps/api/package.json apps/api/
COPY apps/demo-merchant/package.json apps/demo-merchant/
COPY apps/web/package.json apps/web/
# the web app is a static site built elsewhere; keep its dependencies out of this image
RUN pnpm install --frozen-lockfile --filter @noux/api... --filter @noux/demo-merchant...

FROM base AS run
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY pnpm-workspace.yaml package.json ./
COPY packages/core ./packages/core
COPY packages/gateway ./packages/gateway
COPY apps/api ./apps/api
COPY apps/demo-merchant ./apps/demo-merchant
COPY scripts/start.sh /app/start.sh
RUN chmod 755 /app/start.sh
WORKDIR /app/apps/api
USER node
EXPOSE 8787
CMD ["/app/start.sh"]
