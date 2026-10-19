import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { port: 5173, proxy: { '/api': 'http://localhost:4000', '/blog': 'http://localhost:4000', '/pages': 'http://localhost:4000', '/content-media': 'http://localhost:4000', '/content-preview': 'http://localhost:4000', '/sitemap.xml': 'http://localhost:4000', '/robots.txt': 'http://localhost:4000' } } });
