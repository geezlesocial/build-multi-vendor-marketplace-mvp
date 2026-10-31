# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
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

FROM ghcr.io/nginx/nginx-unprivileged:1.31.8-alpine3.24@sha256:03df07e5931f8374d440bd62243a5ce9b24719715ef6fc4c9c626a5f1dbef417
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
