// The app's own version, set by vite from desktop/package.json (vite.config.ts).
// In a run without vite (the tests) there is none, and it reads 0.0.0.
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
