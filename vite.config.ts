import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// UI source lives in ui/, builds to public/ which the API server serves as static files.
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
