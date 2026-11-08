// Builds the page the Android app packages (android/): the website, built for
// no deployment in particular, with relative addresses, into web/dist-app
// (web/vite.config.ts says how, when TB_APP is 1). The same thing from a
// terminal is TB_APP=1 npx vite build --config web/vite.config.ts; this is
// that for a shell without the VAR=value form (Windows) and for the app's
// build command.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.TB_APP = '1';
// The config's root is `web`, relative to where this runs.
process.chdir(repo);
const { build } = await import('vite');
await build({ configFile: path.join(repo, 'web', 'vite.config.ts'), logLevel: 'warn' });
console.log('Built web/dist-app');
