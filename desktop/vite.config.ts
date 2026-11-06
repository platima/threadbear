import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { spike: path.resolve(import.meta.dirname, 'spikes/transcript.html') },
    },
  },
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5183, strictPort: true, host: '127.0.0.1' },
});
