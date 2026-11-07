// node --import scripts/agent-sdk-preload.mjs src/main.ts
// Makes the Claude Agent SDK importable before the runner loads (agent-sdk.mjs
// says how and why). windows-run.mjs starts the runner this way.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preload } from './agent-sdk.mjs';

await preload({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
