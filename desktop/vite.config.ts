import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const { version } = JSON.parse(fs.readFileSync(path.resolve(here, 'package.json'), 'utf8')) as { version: string };

// The transcript spike (spikes/transcript.html, docs/windows-port-plan.md) is a
// measuring page, not part of the app: it is built only when asked for, so it
// does not end up in the installers.
const input: Record<string, string> = { main: path.resolve(here, 'index.html') };
if (process.env.THREADBEAR_SPIKE) input.spike = path.resolve(here, 'spikes/transcript.html');

export default defineConfig({
  root: here,
  base: './',
  plugins: [react()],
  // The app's version, for the update check and Settings > This app.
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input },
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
