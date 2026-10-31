# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS dependencies
WORKDIR /workspace
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY .npmrc .npmrc
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/migrator/package.json packages/migrator/package.json
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu; attempt=1; \
    until npm ci --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-timeout=120000 --no-audit --fund=false; do \
      if [ "$attempt" -ge 3 ]; then exit 1; fi; \
      sleep "$((attempt * 5))"; attempt=$((attempt + 1)); \
    done
COPY apps/api apps/api
COPY tsconfig.base.json ./tsconfig.base.json
# Client generation only needs a syntactically valid datasource URL; never inject
# a real database credential into an image build or build cache.
RUN DATABASE_URL='postgresql://127.0.0.1:5432/marketplace?schema=public' \
    npm exec --workspace=apps/api -- prisma generate --schema prisma/schema.prisma \
    && npm run build --workspace=apps/api

# Dedicated image target for the one-shot deployment migration job.
# Normal API startup never runs migrations.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS production-dependencies
WORKDIR /workspace
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY .npmrc .npmrc
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/migrator/package.json packages/migrator/package.json
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu; attempt=1; \
    until npm ci --omit=dev --workspace=apps/api --include-workspace-root --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-timeout=120000 --no-audit --fund=false; do \
      if [ "$attempt" -ge 3 ]; then exit 1; fi; \
      sleep "$((attempt * 5))"; attempt=$((attempt + 1)); \
    done

# Keep the Prisma CLI in a dedicated migration dependency graph, not the API
# runtime. The CLI is a production dependency of this isolated workspace only.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS migrator-dependencies
WORKDIR /workspace
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY .npmrc .npmrc
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/migrator/package.json packages/migrator/package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu; attempt=1; \
    until npm ci --omit=dev --workspace=apps/api --workspace=packages/migrator --include-workspace-root --registry=https://registry.npmjs.org/ --fetch-retries=5 --fetch-timeout=120000 --no-audit --fund=false; do \
      if [ "$attempt" -ge 3 ]; then exit 1; fi; \
      sleep "$((attempt * 5))"; attempt=$((attempt + 1)); \
    done

# The one-shot image carries only the API runtime dependencies, the Prisma CLI,
# Prisma config, and migration SQL; normal API startup never migrates.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS migrator
ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp
WORKDIR /workspace/apps/api
RUN apk add --no-cache openssl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && addgroup -S -g 10001 marketplace \
    && adduser -S -D -H -u 10001 -G marketplace marketplace
COPY --from=migrator-dependencies --chown=marketplace:marketplace /workspace/node_modules /workspace/node_modules
COPY --chown=marketplace:marketplace apps/api/prisma ./prisma
COPY --chown=marketplace:marketplace apps/api/prisma.config.ts ./prisma.config.ts
USER 10001:10001
CMD ["/workspace/node_modules/.bin/prisma", "migrate", "deploy", "--config", "/workspace/apps/api/prisma.config.ts"]

FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
ENV NODE_ENV=production \
    API_PORT=4000 \
    HOME=/tmp \
    TMPDIR=/tmp \
    NODE_OPTIONS=--require=/workspace/apps/api/runtime/safe-console.cjs
WORKDIR /workspace
RUN apk add --no-cache openssl \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    && addgroup -S -g 10001 marketplace \
    && adduser -S -D -H -u 10001 -G marketplace marketplace
COPY --from=production-dependencies --chown=marketplace:marketplace /workspace/node_modules ./node_modules
COPY --from=dependencies --chown=marketplace:marketplace /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=dependencies --chown=marketplace:marketplace /workspace/apps/api/dist ./apps/api/dist
COPY --chown=marketplace:marketplace package.json ./package.json
COPY --chown=marketplace:marketplace apps/api/package.json ./apps/api/package.json
COPY --chown=marketplace:marketplace apps/api/runtime/safe-console.cjs ./apps/api/runtime/safe-console.cjs
COPY --chown=marketplace:marketplace apps/api/runtime/structured-logger.cjs ./apps/api/runtime/structured-logger.cjs
USER 10001:10001
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/src/index.js"]
