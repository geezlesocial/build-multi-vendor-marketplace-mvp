# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22.23.2-alpine3.24@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS build
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
COPY apps/web apps/web
COPY tsconfig.base.json ./tsconfig.base.json
RUN npm run build --workspace=apps/web

FROM nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
ENV API_UPSTREAM=http://api:4000 DNS_RESOLVER=127.0.0.11
USER root
RUN apk add --no-cache ca-certificates gettext-envsubst
USER 101
COPY --from=build --chown=101:101 /workspace/apps/web/dist /usr/share/nginx/html
COPY infra/containers/nginx/nginx.conf.template /etc/marketplace/nginx.conf.template
COPY infra/containers/nginx/proxy-headers.conf /etc/marketplace/proxy-headers.conf
COPY --chmod=0555 infra/containers/nginx/marketplace-entrypoint.sh /usr/local/bin/marketplace-entrypoint.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -q -O /dev/null http://127.0.0.1:8080/healthz"]
ENTRYPOINT ["/usr/local/bin/marketplace-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
