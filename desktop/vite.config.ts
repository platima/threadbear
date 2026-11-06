import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { main: path.resolve(here, 'index.html'), spike: path.resolve(here, 'spikes/transcript.html') },
    },
  },
  // The UI imports the runner's protocol types and the website's pure view
  // logic (sections, turns), so the dev server may read the repo around it.
  server: {
    port: 5183,
    strictPort: true,
    host: '127.0.0.1',
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/bridge': { target: 'ws://127.0.0.1:5185', ws: true }, '/upload': { target: 'http://127.0.0.1:5185' } },
  },
  preview: { port: 5183, strictPort: true, host: '127.0.0.1' },
});
