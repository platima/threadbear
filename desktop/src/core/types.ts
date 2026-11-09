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

// The Connectors gateway's services, as the runner reports them (docs/protocol.md,
// "Connectors"). Written out here for the same reason as the update types above.
export type ConnectorService = {
  id: string;
  title: string;
  state: 'connected' | 'signed_out' | 'connecting' | 'error' | 'disabled' | 'unknown';
  message?: string;
  connectUrl?: string;
};

export type ConnectorsStatus = {
  state: 'ok' | 'unreachable' | 'off' | 'checking';
  url?: string;
  checkedAt?: string;
  error?: string;
  version?: string;
  release?: string;
  services: ConnectorService[];
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
