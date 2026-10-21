import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const localHost = '127.0.0.1';
const apiPort = Number(process.env.E2E_API_PORT ?? 4000);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const apiOrigin = `http://${localHost}:${apiPort}`;

export default defineConfig({ plugins: [react()], server: { host: localHost, port: webPort, proxy: { '/api': apiOrigin, '/blog': apiOrigin, '/pages': apiOrigin, '/content-media': apiOrigin, '/content-preview': apiOrigin, '/sitemap.xml': apiOrigin, '/robots.txt': apiOrigin } } });
