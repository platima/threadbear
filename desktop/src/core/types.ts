// The runner's own protocol types and constants, shared with the runner.
// They are plain TypeScript with no imports (runner/src/protocol.ts).
export * from '../../../runner/src/protocol.ts';
import type { Account, CliStatus, Pool, RunnerDefaults } from '../../../runner/src/protocol.ts';

// The runner's own update state, from hello and then runner.updates (docs/protocol.md,
// "Runner updates"). Written out here, not imported, as the runner's own definitions
// are in modules that need Node.
export type UpstreamRelease = {
  tag: string;
  commit: string;
  date?: string;
  changes: number;
  subjects: string[];
  important?: { commit: string; why: string }[];
  notes?: { tag: string; lines: string[] }[];
};

export type UpstreamStatus = {
  state: 'off' | 'idle' | 'checking' | 'available' | 'failed';
  reason?: string;
  checkedAt?: string;
  release?: UpstreamRelease;
  published?: { tag: string; at: string };
  held?: { commit: string; why: string; at: string };
};

export type RunnerUpdates = {
  state: 'off' | 'idle' | 'checking' | 'building' | 'waiting' | 'failed';
  commit?: string;
  subject?: string;
  reason?: string;
  oldRunners: { version: string; threads: string[] }[];
  launcherChanged?: true;
  launcherReason?: string;
  upstream?: UpstreamStatus;
};

export type HelloResult = {
  runnerVersion: string;
  protocol: number;
  accounts: Account[];
  pools?: Pool[];
  defaults: RunnerDefaults;
  clis?: CliStatus[];
  updates?: RunnerUpdates;
};
