import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [bicep, proxy, headers] = await Promise.all([
  readFile(new URL('../infra/azure/main.bicep', import.meta.url), 'utf8'),
  readFile(new URL('../infra/containers/nginx/nginx.conf.template', import.meta.url), 'utf8'),
  readFile(new URL('../infra/containers/nginx/proxy-headers.conf', import.meta.url), 'utf8')
]);
const nginxPolicy = `${proxy}\n${headers}`;

assert.match(bicep, /ingress: \{ external: false, targetPort: 4000, transport: 'http', allowInsecure: false \}/);
assert.match(bicep, /\{ name: 'API_UPSTREAM', value: 'https:\/\/\$\{apiInternalFqdn\}' \}/);
assert.match(bicep, /\{ name: 'DNS_RESOLVER', value: '168\.63\.129\.16' \}/);
assert.match(bicep, /migration-preflight'[^\n]*command: \['\.\.\/\.\.\/node_modules\/\.bin\/prisma', 'migrate', 'status', '--config', 'prisma\.config\.ts'\]/);
assert.match(bicep, /migration-deploy'[^\n]*command: \['\.\.\/\.\.\/node_modules\/\.bin\/prisma', 'migrate', 'deploy', '--config', 'prisma\.config\.ts'\]/);
assert.match(nginxPolicy, /proxy_ssl_verify on;/);
assert.match(nginxPolicy, /proxy_ssl_trusted_certificate \/etc\/ssl\/cert\.pem;/);
assert.match(nginxPolicy, /proxy_ssl_server_name on;/);
assert.match(nginxPolicy, /proxy_ssl_name \$proxy_host;/);
assert.match(headers, /proxy_set_header Host \$host;/);
assert.match(headers, /proxy_set_header X-Forwarded-Host \$host;/);
assert.match(proxy, /map \$http_x_forwarded_proto \$marketplace_forwarded_proto/);
assert.match(proxy, /default \$http_x_forwarded_proto;/);
assert.match(headers, /proxy_set_header X-Forwarded-Proto \$marketplace_forwarded_proto;/);
assert.match(headers, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
assert.doesNotMatch(headers, /X-Forwarded-Host \$http_x_forwarded_host/);
assert.doesNotMatch(headers, /X-Forwarded-For \$http_x_forwarded_for/);
console.log('Azure HTTPS upstream and trusted forwarded-header policy checks passed.');
