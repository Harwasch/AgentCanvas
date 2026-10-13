import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the hub (default https://localhost:8443, override with HUB_URL).
const hub = process.env.HUB_URL || 'https://localhost:8443';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    proxy: {
      '/api': { target: hub, changeOrigin: true, secure: false, ws: true },
      '/login': { target: hub, changeOrigin: true, secure: false },
    },
  },
});
