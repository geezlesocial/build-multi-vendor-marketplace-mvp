#!/bin/sh
set -eu

: "${API_UPSTREAM:?API_UPSTREAM must point to the internal Express API}"
if [ -z "${DNS_RESOLVER:-}" ]; then
  DNS_RESOLVER="$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)"
fi
: "${DNS_RESOLVER:?No container/VNet DNS resolver was found}"
export API_UPSTREAM DNS_RESOLVER

mkdir -p /tmp/client_temp /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp
envsubst '${API_UPSTREAM} ${DNS_RESOLVER}' \
  < /etc/marketplace/nginx.conf.template \
  > /tmp/nginx.conf

exec "$@" -c /tmp/nginx.conf
