import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const nginx = readFileSync(new URL('./nginx/nginx.conf.template', import.meta.url), 'utf8');
const headers = readFileSync(new URL('./nginx/proxy-headers.conf', import.meta.url), 'utf8');

assert.match(nginx, /server_tokens\s+off;/);
assert.match(nginx, /client_max_body_size\s+60m;/);
assert.match(nginx, /location\s*=\s*\/api\s*\{\s*proxy_pass\s+\$marketplace_api;/);
assert.match(nginx, /location\s+\^~\s+\/api\//);
assert.match(nginx, /location\s+\/\s*\{\s*try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
assert.doesNotMatch(nginx, /\$request(?:\b|[ ;])/);

for (const path of [
  '/blog',
  '/pages',
  '/sitemap.xml',
  '/robots.txt',
  '/content-media',
  '/content-preview'
]) {
  assert.ok(nginx.includes(path), `Nginx must route ${path} to the API`);
}

assert.ok(nginx.includes('location ~ ^/store/[^/]+/(blog|pages)/[^/]+/?$'));
assert.match(headers, /proxy_set_header\s+Host\s+\$host;/);
assert.match(headers, /proxy_set_header\s+X-Forwarded-Host\s+\$host;/);
assert.match(headers, /proxy_set_header\s+X-Forwarded-Proto\s+\$marketplace_forwarded_proto;/);
assert.match(headers, /proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/);
assert.match(headers, /proxy_ssl_verify\s+on;/);
assert.doesNotMatch(headers, /proxy_set_header\s+(?:Cookie|Authorization)\s+(?:""|''|;)/i);

console.log('Nginx same-origin routing and proxy-header checks passed.');
