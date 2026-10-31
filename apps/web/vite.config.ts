import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const localHost = '127.0.0.1';
const apiPort = Number(process.env.E2E_API_PORT ?? 4000);
const webPort = Number(process.env.E2E_WEB_PORT ?? 5173);
const apiOrigin = `http://${localHost}:${apiPort}`;

const liveEmbedHeaders = {
  name: 'marketplace-live-embed-security-headers',
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (/^\/live\/[^/]+\/embed\/?$/.test(pathname)) {
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*");
      }
      next();
    });
  }
};

export default defineConfig({ plugins: [react(), liveEmbedHeaders], server: { host: localHost, port: webPort, proxy: { '/api': apiOrigin, '/blog': apiOrigin, '/pages': apiOrigin, '/content-media': apiOrigin, '/content-preview': apiOrigin, '/sitemap.xml': apiOrigin, '/robots.txt': apiOrigin } } });
