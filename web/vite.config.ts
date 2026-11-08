import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The website (docs/website.md). Built into web/dist, which
// `npm run web:deploy` uploads to the Convex deployment's static hosting.
//
// With TB_APP=1 it is the Android app's page instead (android/): built for no
// deployment (the app is paired with one, web/src/pairing.ts), with relative
// addresses, into web/dist-app, which the app packages.
export default defineConfig(({ command }) => {
  const app = process.env.TB_APP === '1';
  // The Convex URL is baked in at build time. static-hosting's deploy and
  // `upload --build` set it; a plain build without it would ship a site
  // that can't load anything.
  if (command === 'build' && !app && !process.env.VITE_CONVEX_URL) throw new Error('VITE_CONVEX_URL is not set: use npm run web:deploy');
  return {
    root: 'web',
    envDir: '..',
    base: app ? './' : '/',
    plugins: [react()],
    build: { outDir: app ? 'dist-app' : 'dist', emptyOutDir: true },
    server: { port: 5181 },
  };
});
