# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22.23.2-alpine3.24@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS dependencies
WORKDIR /workspace
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN npm ci
COPY apps/api apps/api
COPY tsconfig.base.json ./tsconfig.base.json
RUN npm exec --workspace=apps/api -- prisma generate --schema prisma/schema.prisma \
    && npm run build --workspace=apps/api

# Dedicated image target for the one-shot deployment migration job.
# Normal API startup never runs migrations.
FROM dependencies AS migrator
ENV NODE_ENV=production
USER node
CMD ["npm", "exec", "--workspace=apps/api", "--", "prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]

FROM node:22.23.2-alpine3.24@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS production-dependencies
WORKDIR /workspace
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/api/prisma apps/api/prisma
RUN npm ci --omit=dev --workspace=apps/api --include-workspace-root

FROM node:22.23.2-alpine3.24@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS runtime
ENV NODE_ENV=production \
    API_PORT=4000 \
    HOME=/tmp \
    TMPDIR=/tmp \
    NODE_OPTIONS=--require=/workspace/apps/api/runtime/safe-console.cjs
WORKDIR /workspace
RUN apk add --no-cache openssl \
    && addgroup -S -g 10001 marketplace \
    && adduser -S -D -H -u 10001 -G marketplace marketplace
COPY --from=production-dependencies --chown=marketplace:marketplace /workspace/node_modules ./node_modules
COPY --from=dependencies --chown=marketplace:marketplace /workspace/node_modules/.prisma ./node_modules/.prisma
COPY --from=dependencies --chown=marketplace:marketplace /workspace/apps/api/dist ./apps/api/dist
COPY --chown=marketplace:marketplace package.json ./package.json
COPY --chown=marketplace:marketplace apps/api/package.json ./apps/api/package.json
COPY --chown=marketplace:marketplace apps/api/runtime/safe-console.cjs ./apps/api/runtime/safe-console.cjs
USER 10001:10001
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/src/index.js"]
