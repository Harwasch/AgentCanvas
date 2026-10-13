import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Self-contained demo build (mock hub, no server): one JS bundle that scripts/build-demo.mjs
// inlines with the CSS and fonts into a single HTML page.
export default defineConfig({
  plugins: [react()],
  base: './',
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  build: {
    outDir: 'dist-demo', emptyOutDir: true, sourcemap: false, target: 'es2022', modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
